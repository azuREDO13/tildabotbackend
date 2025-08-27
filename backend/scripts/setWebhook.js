import('dotenv').then(async ({config})=>{
  config();
  const fetch = (await import('node-fetch')).default || global.fetch;
  const { BOT_TOKEN, PUBLIC_URL } = process.env;
  if(!BOT_TOKEN || !PUBLIC_URL) throw new Error('BOT_TOKEN/PUBLIC_URL missing');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(PUBLIC_URL+'/telegram/webhook')}`;
  const r = await fetch(url); const j = await r.json();
  console.log(j);
});
