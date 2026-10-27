import {CONSENT,validateImportKey} from './import-policy.mjs';
import {withTimeout} from './timeout.mjs';
const button=document.getElementById('import'),status=document.getElementById('status'),consent=document.getElementById('consent'),keyField=document.getElementById('import-key');
button.addEventListener('click',()=>{
  if(!consent.checked){status.textContent='请先明确勾选本次本机加密保存授权';return;}
  let importKey;const advanced=keyField.value.trim();if(advanced){try{importKey=validateImportKey(advanced);}catch{status.textContent='高级连接码无效：不要粘贴地址栏链接；留空即可使用本机连接页已开启的连接。';return;}}
  keyField.value='';button.disabled=true;consent.checked=false;
  // Keep this request directly in the user click handler; never call on startup/alarm.
  const permission=chrome.permissions.request({permissions:['cookies','scripting']});
  withTimeout(()=>permission,30000,'permission_prompt_timeout').then(async granted=>{
    if(!granted){status.textContent='本次未授予导入权限';return;}
    status.textContent='正在从本机已开启的连接获取凭证并加密导入；此处不显示会话值';
    const result=await withTimeout(()=>chrome.runtime.sendMessage({action:'import-once',consent:CONSENT,importKey}),32000,'import_response_timeout');
    const labels={import_connection_not_armed:'请先在本机连接页点击“开启连接”，再回到此处点击本机加密导入',local_import_confirmation_required:'请先在本机连接页开启本次连接，或重新开启已到期连接',local_import_authorization_invalid:'本次连接凭证已失效，请在本机页面重新开启',import_connection_expired:'本机连接已到期，请在本机连接页重新开启连接',import_session_timeout:'本机连接服务等待超时，请检查连接页是否已开启',invalid_import_session:'本机连接凭证校验待核对，请在连接页重新开启连接',no_site_tab:'未找到当前官网标签页',no_site_sessions:'官网标签页没有可导入的已知会话'};
    status.textContent=result?.ok===true?(result.alreadyImported?'此前已导入，本次未重复写入。当前结果：\n':'')+result.results.map(item=>item.platform+'：'+item.status+(item.code?'（'+(labels[item.code]??item.code)+'）':'')).join('\n'):'导入待核对：'+(labels[result?.error]??(typeof result?.error==='string'?result.error:'local_import_failed'));
  }).catch(error=>{status.textContent='导入待核对：'+(['permission_prompt_timeout','import_response_timeout'].includes(error?.message)?error.message:'local_import_failed');}).finally(async()=>{importKey=null;try{await withTimeout(()=>chrome.permissions.remove({permissions:['cookies','scripting']}),2000,'permissions_revoke_timeout');}catch{status.textContent+='\npermissions_revoke_timeout';}button.disabled=false;});
});
