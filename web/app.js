let key=sessionStorage.getItem('ai-credit-admin')??'';let config;
const $=id=>document.getElementById(id);
const fragment=new URLSearchParams(location.hash.slice(1));if(fragment.get('key')){key=fragment.get('key');sessionStorage.setItem('ai-credit-admin',key);history.replaceState(null,'',location.pathname);}
function node(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function notify(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';}
async function api(path,body,method=body===undefined?'GET':'POST'){const r=await fetch('/admin/'+path,{method,headers:{Authorization:'Bearer '+key,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.error?.message??'请求失败');return data;}
async function action(button,fn){button.disabled=true;try{await fn();}catch(e){notify(e.message,true)}finally{button.disabled=false}}
function showResult(data,id='diagnostics'){$(id).hidden=false;$(id).textContent=JSON.stringify(data,null,2);}
function button(label,fn){const b=node('button',label);b.onclick=()=>action(b,fn);return b;}
async function refresh(){config=await api('config');$('configEditor').value=JSON.stringify(config,null,2);$('accountList').replaceChildren();$('upstreamList').replaceChildren();
  for(const a of config.accounts){const card=node('article',undefined,'card');card.append(node('h3',a.label??a.id),node('p',a.platform+' · '+(a.enabled===false?'已关闭':'已启用')),node('small',a.id));const actions=node('div',undefined,'actions');
    actions.append(button('服务端体检',async()=>{showResult(await api('health',{accountId:a.id}));notify('已返回服务端体检结果')}));
    for(const t of a.tasks??[])if(t.enabled)actions.append(button('执行 '+t.id,async()=>{const result=await api('claim',{accountId:a.id,taskId:t.id});showResult(result);notify('领取结果：'+result.status);await records()}));
    actions.append(button(a.enabled===false?'启用':'关闭',async()=>{a.enabled=a.enabled===false;await api('config',config,'PUT');await refresh();notify('账号状态已保存')}));card.append(actions);$('accountList').append(card);
  }
  for(const u of config.upstreams){const card=node('article',undefined,'card');card.append(node('h3',u.id),node('p',u.kind+' · '+(u.enabled===false?'已关闭':'已启用')),node('small',u.accountId??u.baseUrl??''));card.append(button('刷新模型目录',async()=>showResult(await api('catalog',{upstreamId:u.id}),'catalog')));$('upstreamList').append(card);}
  $('runtime').textContent=JSON.stringify(await api('state'),null,2);
}
async function models(){const live=await api('models');
  $('routeList').replaceChildren();for(const route of config.routes){const info=live.data.find(m=>m.id===route.id);const c=node('article',undefined,'card');c.append(node('h3',route.name??route.id),node('code',route.id),node('p',route.targets.map(t=>t.upstreamId+': '+t.model).join(' → ')),node('small',info?'目录已核对 · 工具 '+(info.capabilities.tools?'支持':'未声明')+' · 图片 '+(info.capabilities.multimodal?'支持':'未声明'):'尚未出现在实时可用目录'),node('p','按优先级回退，仅在输出开始前发生'));$('routeList').append(c);}
  notify('已刷新实际可用的模型路由。');
}
async function records(){const {records}=await api('records');$('recordRows').replaceChildren();for(const row of records){const tr=node('tr');for(const text of [new Date(row.time).toLocaleString('zh-CN',{timeZone:config.scheduler.timezone}),row.platform+' / '+row.account_id,row.task,row.status,JSON.stringify(row.result)])tr.append(node('td',text));$('recordRows').append(tr);}}
async function connect(){try{await refresh();$('login').hidden=true;$('main').hidden=false;await records();await models();}catch(e){$('login').hidden=false;$('main').hidden=true;notify(e.message,true);}}
$('loginForm').onsubmit=e=>{e.preventDefault();key=$('adminKey').value;sessionStorage.setItem('ai-credit-admin',key);void connect()};
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>{for(const s of document.querySelectorAll('.panel'))s.hidden=s.id!==b.dataset.tab;for(const n of document.querySelectorAll('[data-tab]'))n.classList.toggle('selected',n===b)};
$('refresh').onclick=e=>action(e.target,refresh);$('doctor').onclick=e=>action(e.target,async()=>showResult(await api('doctor',{})));$('claimAll').onclick=e=>action(e.target,async()=>{showResult(await api('claim',{}));await records()});$('loadRecords').onclick=e=>action(e.target,records);$('loadModels').onclick=e=>action(e.target,models);
$('saveConfig').onclick=e=>action(e.target,async()=>{const c=JSON.parse($('configEditor').value);const r=await api('config',c,'PUT');await refresh();notify(r.serverRestartRequired?'配置已保存；重启服务以应用监听设置':'配置已保存并生效')});
if(key)void connect();
