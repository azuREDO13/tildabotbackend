const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookie = require('cookie-parser');
const axios = require('axios');
require('dotenv').config();

const {
  PORT=8080, BOT_TOKEN, JWT_SECRET, PUBLIC_URL,
  ALLOWED_ORIGIN='*', SUPPORT_GROUP_ID
} = process.env;

if(!BOT_TOKEN || !JWT_SECRET || !PUBLIC_URL){
  console.error('Set BOT_TOKEN, JWT_SECRET, PUBLIC_URL in .env');
  process.exit(1);
}

const TG_API = 'https://api.telegram.org/bot'+BOT_TOKEN;

const app = express();
app.use(express.json({limit:'1mb'}));
app.use(cookie());
app.use(cors({ origin: ALLOWED_ORIGIN.split(','), credentials: true }));

/** In-memory storage (prod: Redis/DB) */
const userToChat = new Map();  // tg_id -> chat_id
const relayMsgMap = new Map(); // group_message_id -> tg_id
const sseClients = new Map();  // tg_id -> Set(res)

/** Utils */
function verifyTelegramLogin(payload){
  // https://core.telegram.org/widgets/login#checking-authorization
  const data = {...payload};
  const hash = data.hash;
  delete data.hash;
  const checkArr = Object.keys(data).sort().map(k=>`${k}=${data[k]}`);
  const dataCheckString = checkArr.join('\n');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const ok = hmac === hash && (Date.now()/1000 - (+data.auth_date)) < (3600*24*7);
  return ok ? { ok:true, user:data } : { ok:false };
}

function auth(req,res,next){
  const h = req.headers.authorization||'';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({ok:false,error:'no token'});
  try{
    const data = jwt.verify(token, JWT_SECRET);
    req.user = data; next();
  }catch(e){ return res.status(401).json({ok:false,error:'bad token'}); }
}

function broadcastTo(tgId, msg){
  const set = sseClients.get(String(tgId));
  if(!set) return;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for(const res of set){ try{ res.write(payload); }catch{} }
}

/** Routes */
// Login from Telegram widget
app.post('/auth/telegram', (req,res)=>{
  const vr = verifyTelegramLogin(req.body||{});
  if(!vr.ok) return res.status(401).json({ok:false,error:'auth failed'});

  const tgId = String(vr.user.id);
  const token = jwt.sign({ tg_id: tgId, name: vr.user.first_name||'' }, JWT_SECRET, { expiresIn:'7d' });
  const chatId = userToChat.get(tgId);
  return res.json({ ok:true, token, tgId, needStart: !chatId });
});

app.get('/me', auth, (req,res)=>{
  const tgId = req.user.tg_id;
  res.json({ ok:true, tgId, chatBound: !!userToChat.get(String(tgId)) });
});

// SSE stream
app.get('/chat/stream', (req,res)=>{
  const token = req.query.token;
  if(!token) return res.status(401).end();
  let data;
  try{ data = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }

  const tgId = String(data.tg_id);
  res.writeHead(200, {
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN.split(',')[0] || '*'
  });
  res.write(':\n\n');

  const set = sseClients.get(tgId) || new Set();
  set.add(res); sseClients.set(tgId, set);

  const ping = setInterval(()=>{ try{ res.write('event: ping\ndata: {}\n\n'); }catch{} }, 25000);

  req.on('close', ()=>{
    clearInterval(ping);
    const s = sseClients.get(tgId);
    if(s){ s.delete(res); if(!s.size) sseClients.delete(tgId); }
  });
});

// send from web → Telegram
app.post('/chat/send', auth, async (req,res)=>{
  const tgId = String(req.user.tg_id);
  const chatId = userToChat.get(tgId);
  if(!chatId) return res.status(409).json({ok:false, needStart:true});

  const text = (req.body?.text||'').toString().slice(0,2000);
  if(!text) return res.status(400).json({ok:false});

  try{
    await axios.post(TG_API+'/sendMessage', { chat_id: chatId, text });
    broadcastTo(tgId, { role:'operator', text, ts: Date.now() });
    res.json({ok:true});
  }catch(e){
    console.error('sendMessage error', e?.response?.data || e.message);
    res.status(500).json({ok:false});
  }
});

/** Telegram webhook */
app.post('/telegram/webhook', async (req,res)=>{
  res.sendStatus(200);
  try{
    const upd = req.body;

    // Private chat: message from user
    if(upd.message && upd.message.chat && upd.message.chat.type === 'private'){
      const m = upd.message;
      const tgId = String(m.from.id);
      userToChat.set(tgId, m.chat.id);

      if(m.text){
        broadcastTo(tgId, { role:'user', text:m.text, ts: (m.date||0)*1000 });
      }

      // Mirror to operators group (optional)
      if(SUPPORT_GROUP_ID){
        try{
          const resp = await axios.post(TG_API+'/copyMessage', {
            chat_id: SUPPORT_GROUP_ID,
            from_chat_id: m.chat.id,
            message_id: m.message_id
          });
          const groupMsgId = resp.data?.result?.message_id;
          if(groupMsgId) relayMsgMap.set(String(groupMsgId), tgId);

          const who = (m.from.first_name||'Пользователь') + (m.from.username?` (@${m.from.username})`:``);
          await axios.post(TG_API+'/sendMessage', {
            chat_id: SUPPORT_GROUP_ID,
            text: `From: ${who}\nTG ID: ${tgId}`,
            reply_to_message_id: groupMsgId || undefined
          });
        }catch(e){ console.error('notify group error', e?.response?.data || e.message); }
      }
    }

    // Reply from operators group
    if(upd.message && upd.message.chat && (upd.message.chat.type==='group' || upd.message.chat.type==='supergroup')){
      const m = upd.message;
      if(m.reply_to_message){
        const key = String(m.reply_to_message.message_id);
        const tgt = relayMsgMap.get(key);
        if(tgt){
          const text = m.text || '(non-text)';
          try{
            await axios.post(TG_API+'/sendMessage', { chat_id: userToChat.get(tgt), text });
            broadcastTo(tgt, { role:'operator', text, ts: (m.date||0)*1000 });
          }catch(e){ console.error('send to user from group error', e?.response?.data || e.message); }
        }
      }
    }
  }catch(e){
    console.error('webhook error', e.message);
  }
});

/** Service */
app.get('/', (_,res)=>res.send('ok'));
app.listen(PORT, ()=>console.log('tg-support listening on', PORT));
