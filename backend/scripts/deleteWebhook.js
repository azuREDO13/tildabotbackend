import('dotenv').then(async ({config})=>{
  config();
  const fetch = (await import('node-fetch')).default || global.fetch;
  const { BOT_TOKEN } = process.env;
  if(!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
  console.log(await r.json());
});
