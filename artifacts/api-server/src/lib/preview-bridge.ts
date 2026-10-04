/** Executed only inside the opaque-origin project iframe, never in Forge. */
export function previewBridge(base: string) {
  const prefix = JSON.stringify(base).replaceAll("<", "\\u003c");
  return `<script>(()=>{
const base=${prefix};
let picking=false, highlighted=null, previousOutline="";
function unhighlight(){if(highlighted){highlighted.style.outline=previousOutline;highlighted=null}}
window.addEventListener("message",e=>{
  if(e.source!==parent||!e.data)return;
  if(e.data.type==="forge-design-mode"){picking=!!e.data.enabled;if(!picking)unhighlight()}
  if(e.data.type==="forge-design-css"&&typeof e.data.css==="string"&&e.data.css.length<100000){
    let style=document.getElementById("forge-visual-preview");
    if(!style){style=document.createElement("style");style.id="forge-visual-preview";document.head.append(style)}
    style.textContent=e.data.css;
  }
});
document.addEventListener("pointerover",e=>{
  if(!picking||!(e.target instanceof HTMLElement))return;
  unhighlight();highlighted=e.target;previousOutline=highlighted.style.outline;highlighted.style.outline="2px solid #ff7a18";
},true);
document.addEventListener("click",e=>{
  if(!picking||!(e.target instanceof HTMLElement))return;
  e.preventDefault();e.stopImmediatePropagation();unhighlight();
  const el=e.target;let parts=[],node=el;
  while(node&&node!==document.body){
    if(node.id&&/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(node.id)){parts.unshift("#"+node.id);break}
    const siblings=node.parentElement?Array.from(node.parentElement.children).filter(n=>n.tagName===node.tagName):[node];
    parts.unshift(node.tagName.toLowerCase()+":nth-of-type("+(siblings.indexOf(node)+1)+")");node=node.parentElement;
  }
  const selector=parts.length?parts.join(" > "):"body";
  const computed=getComputedStyle(el),styles={};
  for(const key of ["color","background-color","font-size","font-weight","line-height","padding","margin","border-radius","width","max-width","text-align"])styles[key]=computed.getPropertyValue(key);
  parent.postMessage({type:"forge-design-selection",selector,text:el.textContent.slice(0,300),styles},"*");
},true);
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