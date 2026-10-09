// usage: node req.js <url> [maxMs]  -> prints one JSON line (timings on the drv pod clock)
const http = require('http');
const url = new URL(process.argv[2]);
const maxMs = Number(process.argv[3] || 120000);
const t0 = Date.now(), p0 = performance.now();
const req = http.get({host:url.hostname, port:url.port||80, path:url.pathname, agent:false, timeout:maxMs}, res => {
  let b=''; res.on('data',d=>b+=d); res.on('end',()=>{
    console.log(JSON.stringify({t0, t1:Date.now(), ms:Math.round(performance.now()-p0), code:res.statusCode, body:b.slice(0,300)}));
  });
});
req.on('timeout',()=>{req.destroy(new Error('timeout'))});
req.on('error',e=>console.log(JSON.stringify({t0, t1:Date.now(), ms:Math.round(performance.now()-p0), code:0, err:String(e)})));
