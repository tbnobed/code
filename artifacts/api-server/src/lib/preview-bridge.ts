/** Executed only inside the opaque-origin project iframe, never in Forge. */
export function previewBridge(base: string) {
  const prefix = JSON.stringify(base).replaceAll("<", "\\u003c");
  return `<script>(()=>{
const base=${prefix};
const rewrite=u=>typeof u==="string"&&u.startsWith("/")&&!u.startsWith("//")&&!u.startsWith(base+"/")&&u!==base?base+u:u;
const fetchOriginal=window.fetch.bind(window);
window.fetch=(input,init)=>fetchOriginal(typeof input==="string"?rewrite(input):input,init);
const open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,rewrite(url),...rest)};
const OriginalWebSocket=window.WebSocket;
window.WebSocket=class extends OriginalWebSocket {
  constructor(url,protocols){
    const u=new URL(url,location.href);
    if(u.host===location.host)u.pathname=rewrite(u.pathname);
    super(u.href,...(protocols===undefined?[]:[protocols]));
  }
};
function report(message){parent.postMessage({type:"forge-preview-error",message:String(message).slice(0,4000)},"*")}
window.addEventListener("error",e=>report(e.message+" "+(e.filename||"")+":"+e.lineno));
window.addEventListener("unhandledrejection",e=>report(e.reason?.stack||e.reason?.message||e.reason));
})();</script>`;
}