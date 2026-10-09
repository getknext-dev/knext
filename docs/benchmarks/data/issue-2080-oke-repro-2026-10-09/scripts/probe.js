// usage: node probe.js ip:port ...   -> one JSON line of {target: status|err} (2 s timeout each)
const http = require('http');
const one = t => new Promise(r => { const [h,p]=t.split(':'); const s=Date.now();
  const q = http.get({host:h,port:p,path:'/api/health',agent:false,timeout:2000}, res => {res.resume(); res.on('end',()=>r([t,{code:res.statusCode,ms:Date.now()-s}]));});
  q.on('timeout',()=>q.destroy(new Error('timeout'))); q.on('error',e=>r([t,{err:e.code||String(e),ms:Date.now()-s}])); });
Promise.all(process.argv.slice(2).map(one)).then(a=>console.log(JSON.stringify({at:Date.now(),res:Object.fromEntries(a)})));
