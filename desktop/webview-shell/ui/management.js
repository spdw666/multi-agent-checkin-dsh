(() => {
  'use strict';
  const CONTRACT = {
  "version": 1,
  "request": {
    "read": {
      "method": "read",
      "section": "accounts|routes|records|preferences|diagnostics|workbuddy|updates|operations",
      "view": "optional enum per section",
      "accountId": "optional configured id",
      "limit": "1..1000",
      "query": "optional text <=200",
      "jobId": "optional UUID",
      "requestId": "optional id <=120"
    },
    "action": {
      "method": "action",
      "action": "enum below",
      "confirmed": "must be true, otherwise cancelled with zero HTTP",
      "revision": "configuration revision from read for local config writes",
      "accountId": "when applicable",
      "values": "typed fields below",
      "items": "model selections when applicable",
      "accountIds": "WB export or merge/pool members",
      "routeIds": "models.export or model tests",
      "content": "WB import JSON or base64 ZIP; passed by stdin, never echoed"
    }
  },
  "response": {
    "read": "{section,data,revision}",
    "action": "{operation:{kind,status:completed|failed|cancelled|uncertain,message},data?}",
    "hostOnly": "export:{suggestedName,content,encoding:base64|utf8} and external:{kind:workbuddy-login,url}; host intercepts, never forwards those fields to page"
  },
  "reads": {
    "accounts": {
      "views": [
        "list"
      ],
      "data": "{accounts:[{id,label,platform,edition,enabled,inferenceEnabled,notes,tasks:[{id,enabled}],credentialConfigured}],upstreams:[{id,kind,accountId,enabled}]}"
    },
    "routes": {
      "views": [
        "config",
        "directory",
        "audit",
        "relay",
        "freeProviders"
      ],
      "data": "default:{routes:[{id,name,enabled,targets:[{upstreamId,model}],accountPool?}],upstreams:[{id,kind,accountId,enabled}],relay}; directory:{providers:[...sanitized model directory...]}; audit:{status,total,completed,results:[...]}; relay:typed sanitized backend report; freeProviders:{providers:[...]}"
    },
    "records": {
      "views": [
        "claims",
        "usage"
      ],
      "data": "{records:[sanitized record],...counts}; claims default; accountId optional"
    },
    "preferences": {
      "views": [
        "config"
      ],
      "data": "{scheduler:{enabled,startup,timezone,hour,minute,jitterSeconds,retryMinutes},server:{host,port},modelRelay,workbuddy:{autoMigrateSessions,autoTasks},accounts:[public metadata]}"
    },
    "diagnostics": {
      "views": [
        "context",
        "requests",
        "activation",
        "audit"
      ],
      "data": "sanitized corresponding report; query maps search, requestId only for requests"
    },
    "workbuddy": {
      "views": [
        "summary",
        "details",
        "rotation",
        "tasks",
        "taskJob",
        "pools"
      ],
      "data": "summary:{accounts:[{id,accountId,label,notes,edition,enabled,inferenceEnabled,current,remaining,total,consumed,checkedAt,lastSuccessAt,lastFailureAt,stale,usageStatus,credentialStatus,balance,tasks,dailyCheckin,ban}],currentAccountId,totals,models,settings,sessionCapabilities}; details:{account:<same DTO>,refreshed}; tasks/taskJob:{job/snapshot/tasks...}; rotation:{settings,state,preview}; pools:{routes}"
    },
    "updates": {
      "views": [
        "report"
      ],
      "data": "sanitized client-updates report"
    },
    "operations": {
      "views": [
        "report",
        "keys"
      ],
      "data": "{settings,health,expiry,notifications,keys,sessions,routes,...}; keys metadata only, never secret key"
    }
  },
  "actions": {
    "account.add": {
      "values": {
        "id": "required id",
        "label": "required text128",
        "platform": "required platform",
        "edition": "cn|ai|global|intl optional",
        "enabled": "bool",
        "inferenceEnabled": "bool",
        "notes": "text2000",
        "credentialFile": "text2048",
        "credentialSource": "desktop|file optional",
        "tasks": "array<{id,enabled}>"
      },
      "revisionRequired": true
    },
    "account.update": {
      "accountId": "required",
      "values": {
        "label": "text128",
        "notes": "text2000",
        "edition": "cn|ai|global|intl",
        "credentialFile": "text2048",
        "credentialSource": "desktop|file"
      },
      "revisionRequired": true
    },
    "account.enable": {
      "accountId": "required",
      "values": {
        "enabled": "required bool"
      },
      "revisionRequired": true
    },
    "account.delete": {
      "accountId": "required",
      "values": {}
    },
    "account.tasks": {
      "accountId": "required",
      "values": {
        "tasks": "required array<{id,enabled}>"
      },
      "revisionRequired": true
    },
    "route.save": {
      "values": {
        "id": "required id",
        "name": "text200",
        "enabled": "bool",
        "targets": "array<{upstreamId,model}>",
        "fallbackStatuses": "array<int100..599>"
      },
      "revisionRequired": true
    },
    "route.enable": {
      "values": {
        "id": "required id",
        "enabled": "required bool"
      },
      "revisionRequired": true
    },
    "route.delete": {
      "values": {
        "id": "required id"
      },
      "revisionRequired": true
    },
    "route.reorder": {
      "values": {
        "routeId": "required id",
        "expectedTargets": "required array<{upstreamId,model}>",
        "targets": "required array<{upstreamId,model}>"
      }
    },
    "scheduler.save": {
      "values": {
        "enabled": "bool",
        "startup": "bool",
        "timezone": "text80",
        "hour": "int0..23",
        "minute": "int0..59",
        "jitterSeconds": "int0..3600",
        "retryMinutes": "int1..1440"
      },
      "revisionRequired": true
    },
    "server.save": {
      "values": {
        "host": "localhost|loopback|0.0.0.0",
        "port": "int1..65535"
      },
      "revisionRequired": true
    },
    "relay.save": {
      "values": {
        "enabled": "bool",
        "reservePercent": "number0..50",
        "reserveCredits": "number0..100000",
        "partitions": "{workbuddy?:bool,other?:bool}"
      }
    },
    "models.directory": {
      "values": {}
    },
    "models.test": {
      "values": {
        "scope": "all|selected|models",
        "routeIds": "array<id>",
        "items": "array<{upstreamId,model}>"
      }
    },
    "models.import": {
      "items": "required array<{upstreamId,model,enabled?,importedRouteIds?}>",
      "values": {
        "enabled": "bool"
      }
    },
    "models.export": {
      "routeIds": "required array<id>",
      "values": {},
      "note": "REMOVES imported models by disabling selected routes; this endpoint does not download a file"
    },
    "diagnostics.doctor": {
      "values": {}
    },
    "diagnostics.health": {
      "accountId": "required",
      "values": {}
    },
    "diagnostics.rebind": {
      "accountId": "required",
      "values": {}
    },
    "diagnostics.routePreview": {
      "values": {
        "routeId": "required id",
        "inputChars": "int0..10000000",
        "outputBudget": "int0..1000000",
        "requiresTools": "bool",
        "hasImages": "bool",
        "hasToolHistory": "bool",
        "messageCount": "int1..10000",
        "toolCount": "int0..1000",
        "stream": "bool",
        "multiRole": "bool",
        "explicitParameters": "array<id>"
      }
    },
    "wb.settings": {
      "values": {
        "autoMigrateSessions": "bool",
        "autoTasks": "bool"
      }
    },
    "wb.profile": {
      "accountId": "required",
      "values": {
        "label": "text128",
        "notes": "text2000"
      }
    },
    "wb.inference": {
      "accountId": "required",
      "values": {
        "enabled": "required bool"
      }
    },
    "wb.refresh": {
      "accountId": "optional",
      "values": {}
    },
    "wb.switch": {
      "accountId": "required",
      "values": {
        "migrate": "bool",
        "switchClient": "bool"
      }
    },
    "wb.markStatus": {
      "accountId": "required",
      "values": {
        "status": "banned|clear",
        "reason": "text180",
        "confirm": "bool"
      }
    },
    "wb.tasks": {
      "accountId": "optional",
      "values": {
        "action": "run|accept|claim|query",
        "taskCode": "text256",
        "taskCodes": "array<text256>"
      }
    },
    "wb.tasksCancel": {
      "jobId": "required UUID",
      "values": {}
    },
    "wb.rotation": {
      "values": {
        "enabled": "bool",
        "target": "gateway|codebuddy-cli|both",
        "strategy": "expiry|round_robin",
        "intervalMinutes": "int1..1440",
        "cooldownMinutes": "int0..10080",
        "minUrgencyHours": "int0..8760",
        "minRemainingCredits": "number0..1000000",
        "minGapHours": "int0..8760",
        "edition": "cn|ai"
      }
    },
    "wb.rotationEvaluate": {
      "values": {
        "dryRun": "bool"
      }
    },
    "wb.importPreview": {
      "content": "required text <=6MiB",
      "values": {
        "format": "json|zip"
      }
    },
    "wb.importCommit": {
      "content": "required text <=6MiB",
      "values": {
        "format": "json|zip",
        "duplicatePolicy": "skip|replace",
        "selectedIndexes": "array<int0..999>"
      }
    },
    "wb.export": {
      "accountIds": "required array<configured WB id>",
      "values": {
        "format": "json|zip|switch-json"
      },
      "hostFileSave": true
    },
    "wb.capture": {
      "values": {
        "id": "required id",
        "label": "text128"
      }
    },
    "wb.loginStart": {
      "values": {
        "edition": "cn|ai|global|intl",
        "label": "text100"
      },
      "hostOfficialBrowser": true
    },
    "wb.loginPoll": {
      "values": {
        "loginId": "required UUID"
      }
    },
    "wb.loginCancel": {
      "values": {
        "loginId": "required UUID"
      }
    },
    "wb.merge": {
      "accountIds": "required array<WB id>",
      "values": {
        "targetAccountId": "required WB id"
      }
    },
    "wb.pool": {
      "accountIds": "required array<WB id>",
      "values": {
        "routeId": "required id",
        "enabled": "bool",
        "cooldownSeconds": "int0..86400"
      }
    },
    "wb.poolSelect": {
      "accountId": "required",
      "values": {
        "routeId": "required id"
      }
    },
    "updates.check": {
      "values": {
        "failedOnly": "bool",
        "targetIds": "array<id>"
      }
    },
    "operations.settings": {
      "values": {
        "notificationsEnabled": "bool",
        "strategy": "configured|stable|fast|expiry",
        "affinityEnabled": "bool",
        "affinityTtlMinutes": "int1..1440"
      }
    },
    "operations.keyCreate": {
      "values": {
        "name": "required text80",
        "allowedModels": "array<existing route id>",
        "dailyRequestLimit": "int0..1000000000",
        "dailyTokenLimit": "int0..1000000000",
        "dailyKnownCreditLimit": "number0..1000000000",
        "maxConcurrency": "int0..1000"
      },
      "hostFileSave": true
    },
    "operations.keyRevoke": {
      "values": {
        "id": "required id"
      }
    },
    "operations.notificationRead": {
      "values": {
        "id": "required hex24"
      }
    },
    "updates.settings": {
      "values": {
        "enabled": "bool",
        "intervalHours": "number1..720",
        "timeoutMs": "int1000..120000"
      },
      "revisionRequired": true
    },
    "freeProvider.add": {
      "values": {
        "models": "array<text256>",
        "accountId": "text32",
        "providerId": "required id",
        "id": "required id",
        "apiKey": "text16384",
        "credentialFile": "text2048"
      }
    },
    "upstream.save": {
      "values": {
        "credentialFile": "text2048",
        "timeoutMs": "int1000..600000",
        "id": "required id",
        "accountId": "text120",
        "kind": "text50",
        "enabled": "bool",
        "baseUrl": "text2048",
        "maxOutputTokens": "int1..1000000"
      },
      "revisionRequired": true
    },
    "upstream.delete": {
      "values": {
        "id": "required id"
      },
      "revisionRequired": true
    },
    "diagnostics.restartDsh": {
      "values": {}
    }
  }
};
  const sections={accounts:['账号管理','配置平台账号、登录来源与签到任务。'],routes:['路由配置','管理模型入口、接力次序和导入体检。'],records:['领取记录','核对完整领取回执与调用账本。'],preferences:['业务偏好','签到调度、服务监听与接力设置。'],diagnostics:['请求诊断','账号认证、路由预览和请求上下文。'],workbuddy:['WorkBuddy 账号池','浏览账号、切换登录、管理积分调用与任务。'],updates:['软件更新','版本、检查状态与更新策略。'],operations:['运行中心','服务运行、通知、应用密钥与会话策略。']};
  const labels={'account.add':'添加账号','account.update':'修改账号资料','account.enable':'启用 / 停用账号','account.delete':'删除账号','account.tasks':'配置签到任务','route.save':'保存路由配置','route.delete':'删除路由','route.enable':'启用 / 停用路由','route.reorder':'调整接力次序','scheduler.save':'修改签到计划','server.save':'服务监听设置','relay.save':'模型接力设置','models.directory':'刷新模型目录','models.test':'执行模型体检','models.import':'导入所选模型','models.export':'移出已导入模型','diagnostics.doctor':'检查认证来源','diagnostics.health':'核验账号连接','diagnostics.rebind':'重新绑定账号','diagnostics.routePreview':'预览路由决策','wb.settings':'账号池设置','wb.profile':'修改名称与备注','wb.inference':'切换积分调用','wb.refresh':'刷新积分','wb.switch':'切换此号','wb.markStatus':'标记账号状态','wb.tasks':'积分任务操作','wb.tasksCancel':'取消任务等待','wb.rotation':'轮换设置','wb.rotationEvaluate':'预览 / 评估轮换','wb.importPreview':'预览导入账号','wb.importCommit':'提交导入账号','wb.export':'导出账号','wb.capture':'保存客户端当前登录','wb.loginStart':'添加登录','wb.loginPoll':'检查登录结果','wb.loginCancel':'取消登录','wb.merge':'合并聊天副本','wb.pool':'配置路由账号池','wb.poolSelect':'选择路由账号','updates.check':'检查软件更新','updates.settings':'更新检查设置','operations.settings':'运行策略设置','operations.keyCreate':'创建应用密钥','operations.keyRevoke':'撤销应用密钥','operations.notificationRead':'标记通知已读'};
  const fieldLabels={id:'标识',label:'显示名称',name:'名称',platform:'平台',edition:'客户端版本',enabled:'启用',inferenceEnabled:'启用积分调用',notes:'备注',credentialFile:'凭据文件路径',credentialSource:'登录来源',tasks:'签到任务',targets:'模型目标',fallbackStatuses:'允许接力的HTTP状态',routeId:'路由标识',expectedTargets:'当前目标次序',timezone:'时区',startup:'启动后检查',hour:'小时',minute:'分钟',jitterSeconds:'随机延迟（秒）',retryMinutes:'重试间隔（分钟）',host:'监听地址',port:'端口',reservePercent:'保留百分比',reserveCredits:'保留积分',partitions:'接力分区',scope:'体检范围',routeIds:'路由选择',items:'模型条目',model:'模型',sessionId:'会话标识',clientId:'客户端标识',inputChars:'输入字符数',outputBudget:'输出预算',autoMigrateSessions:'自动迁移聊天',autoTasks:'自动任务',migrate:'迁移聊天副本',switchClient:'同步切换客户端',status:'状态',reason:'原因',confirm:'确认标记',action:'任务动作',taskCode:'任务编码',taskCodes:'任务编码列表',target:'轮换目标',strategy:'策略',intervalMinutes:'检查间隔（分钟）',cooldownMinutes:'冷却时间（分钟）',minUrgencyHours:'紧迫阈值（小时）',minRemainingCredits:'最低剩余积分',minGapHours:'最小间隔（小时）',dryRun:'仅预览，不改变登录',format:'文件格式',duplicatePolicy:'重复账号处理',selectedIndexes:'选中导入项索引',targetAccountId:'目标账号',cooldownSeconds:'接力冷却（秒）',loginId:'登录任务标识',failedOnly:'只重查失败项',targetIds:'更新目标标识',notificationsEnabled:'启用通知',affinityEnabled:'启用会话亲和',affinityTtlMinutes:'亲和保留（分钟）',allowedModels:'允许模型列表',dailyRequestLimit:'每日请求上限',dailyTokenLimit:'每日Token上限',dailyKnownCreditLimit:'每日已知积分上限',maxConcurrency:'最大并发',intervalHours:'检查间隔（小时）',timeoutMs:'超时（毫秒）',dailyLimit:'每日上限',accountId:'账号',accountIds:'账号选择',jobId:'任务标识',content:'导入文件',revision:'配置版本'};
  const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr=v=>Array.isArray(v)?v:[];
  const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
  const state={section:null,data:null,revision:null,loading:false,busy:false,error:'',query:'',page:1,pageSize:10,selected:null,tab:'profile',view:'',extra:null,result:null,dialog:null,login:null,job:null};
  let ctx=null,readSequence=0,dialogSequence=0,importPayload=null;
  const fmt=v=>v===null||v===undefined||v===''?'待获取':typeof v==='number'?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(v):String(v);
  const valueText=v=>v===null||v===undefined||v===''?'未记录':typeof v==='boolean'?(v?'启用':'关闭'):typeof v==='object'?Array.isArray(v)?v.map(x=>typeof x==='object'?x.label||x.name||x.id||x.model||'记录':x).join('、'):Object.entries(v).filter(([k,x])=>x===null||['string','number','boolean'].includes(typeof x)).map(([k,x])=>(fieldLabels[k]||k)+'：'+valueText(x)).join('；'):String(v);
  const time=v=>{if(!v)return '未记录';const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d):String(v);};
  const badge=(text,kind='neutral')=>'<span class="badge '+esc(kind)+'">'+esc(text)+'</span>';
  const button=(action,text,accountId='',values={},extra='')=>'<button class="button" type="button" data-m-action="'+esc(action)+'" data-m-account="'+esc(accountId)+'" data-m-values="'+esc(JSON.stringify(values))+'" '+extra+' '+(state.busy||ctx?.busy?.()?'disabled':'')+'>'+esc(text||labels[action]||action)+'</button>';
  const link=(action,text,accountId='',values={})=>'<button class="text-button" type="button" data-m-action="'+esc(action)+'" data-m-account="'+esc(accountId)+'" data-m-values="'+esc(JSON.stringify(values))+'" '+(state.busy||ctx?.busy?.()?'disabled':'')+'>'+esc(text||labels[action]||action)+'</button>';

  function statusText(value){return ({available:'可用',current:'已是当前版本',update_available:'有新版本',configured:'已配置',unknown:'待核验',authenticated:'认证有效',inference_disabled:'积分调用已停用',inference_enabled:'积分调用已启用',success:'成功',completed:'完成',failed:'失败',error:'异常',rejected:'已拒绝',pending:'待处理',running:'进行中',busy:'处理中',accepted:'已接受',already:'已领取',claimed:'已领取',not_installed:'尚未安装',installed:'已安装',not_configured:'未配置',unavailable:'暂不可用',skipped:'已跳过',checking:'检查中',idle:'空闲',done:'检查完成',stale:'历史记录',expired:'已到期',exhausted:'已耗尽',active:'可用',invalid:'无效',disabled:'已停用',enabled:'启用',saved:'已保存',waiting:'等待中',cancelled:'已取消',uncertain:'待确认',warning:'需要留意',healthy:'正常',none:'无',online:'在线',offline:'离线',manual:'手动',automatic:'自动',dsh:'DSH',hermes:'Hermes',desktop:'桌面工作台'})[String(value||'').toLowerCase()]||'待核对';}
  function healthTable(items){return table([['账号 / 模型','model',r=>'<strong>'+esc(r.label||r.accountId||r.upstreamId)+'</strong><small>'+esc(r.model||'')+'</small>'],['调用状态','status',r=>badge(statusText(r.status),r.status==='error'?'error':'neutral')],['活动请求','active',r=>esc(fmt(r.active??r.inFlight))],['首Token延迟','firstTokenMs',r=>esc(r.firstTokenMs??r.ttftMs??'尚无样本')],['说明','reason',r=>esc(r.reason||'—')]],items);}

  function rows(name){const data=obj(state.data);return arr(data[name]??obj(data.summary)[name]??obj(data.report)[name]);}
  function allAccounts(){if(Array.isArray(obj(state.data).accounts))return state.data.accounts;const list=arr(ctx?.snapshot()?.accounts);return state.section==='workbuddy'?list.filter(a=>['workbuddy','workbuddyai','codebuddy'].includes(a.platform)):list;}
  function idOf(a){return String(a.accountId??a.id??'');}
  function labelOf(a){return a.label||a.name||idOf(a)||'未命名账号';}
  function current(){return allAccounts().find(a=>idOf(a)===String(state.selected))||allAccounts()[0]||null;}
  function facts(pairs){return '<dl class="m-facts">'+pairs.map(([name,value])=>'<div class="m-fact"><dt>'+esc(name)+'</dt><dd>'+esc(valueText(value))+'</dd></div>').join('')+'</dl>';}
  function empty(title,description='当前读取结果没有对应记录。'){return '<div class="empty-state">'+ctx.icon('empty')+'<h2>'+esc(title)+'</h2><p>'+esc(description)+'</p></div>';}
  function table(columns,items){return '<div class="m-table-wrap"><table class="m-table"><thead><tr>'+columns.map(c=>'<th scope="col">'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+items.map(row=>'<tr>'+columns.map(c=>'<td>'+(c[2]?c[2](row):esc(valueText(row[c[1]])))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
  function filtered(items){const q=state.query.toLowerCase();return items.filter(row=>!q||Object.values(row).filter(v=>['string','number','boolean'].includes(typeof v)).join(' ').toLowerCase().includes(q));}
  function status(){if(state.error)return '<div class="m-status error" role="alert">'+ctx.icon('warning')+'<div>'+esc(state.error)+'</div></div>';if(state.busy)return '<div class="m-status" role="status">'+ctx.icon('clock')+'<div><strong>后台操作进行中</strong>请等待结果；同一操作不会重复提交。</div></div>';const r=state.result?.operation;if(!r)return '';const kind=r.status==='failed'?'error':r.status==='uncertain'?'warning':r.status==='completed'?'ok':'';return '<div class="m-status '+kind+'" role="status">'+ctx.icon(kind==='error'||kind==='warning'?'warning':'info')+'<div><strong>'+esc(({completed:'操作已返回',failed:'操作失败',cancelled:'操作已取消',uncertain:'结果待核对'})[r.status]||'后台结果')+'</strong>'+esc(r.message||'请核对当前记录。')+'</div></div>';}
  function toolbar(actions=[],search=true){return '<div class="m-toolbar">'+(search?'<label class="search-field">'+ctx.icon('search')+'<span class="sr-only">搜索管理记录</span><input id="managementSearch" placeholder="搜索名称、ID 或状态" value="'+esc(state.query)+'" autocomplete="off"></label>':'<span class="m-overline">数据来自现有后台，修改以返回回执为准。</span>')+'<div class="m-toolbar-actions">'+actions.join('')+'<button class="button" type="button" data-m-reload '+(state.loading||state.busy?'disabled':'')+'>重新读取</button></div></div>';}
  function secondaryTabs(items){return '<nav class="m-tabs" aria-label="管理详情">'+items.map(([id,label])=>'<button type="button" data-m-tab="'+id+'" class="'+(state.tab===id?'is-active':'')+'">'+label+'</button>').join('')+'</nav>';}
  function renderWB(){const all=allAccounts(),items=filtered(all),pageCount=Math.max(1,Math.ceil(items.length/state.pageSize));state.page=Math.max(1,Math.min(state.page,pageCount));if(!items.some(a=>idOf(a)===String(state.selected)))state.selected=idOf(items[0]||{});const a=items.find(a=>idOf(a)===String(state.selected)),totals=obj(obj(state.data).totals),settings=obj(obj(state.data).settings);const amount=totals.remaining??all.filter(x=>!x.stale&&Number.isFinite(Number(x.remaining))).reduce((sum,x)=>sum+Number(x.remaining),0);const total=totals.total;const list=items.slice((state.page-1)*state.pageSize,state.page*state.pageSize);const actions=[button('wb.loginStart','添加登录'),button('wb.capture','保存当前登录'),button('wb.refresh','刷新全部积分'),button('wb.importPreview','导入账号'),button('wb.export','导出账号'),button('wb.rotation','轮换设置'),button('wb.settings','账号池设置','',settings)];return toolbar(actions)+loginPanel()+importPanel()+'<section class="m-pool-summary"><div><p>池积分剩余 / 总额</p><div class="m-pool-amount"><strong>'+esc(total===undefined?(totals.remaining===undefined?'待核对':fmt(totals.remaining)):fmt(amount)+' / '+fmt(total))+'</strong><span>积分</span></div></div><p class="m-overline">共 '+all.length+' 个账号 · 推理调用 '+all.filter(a=>a.inferenceEnabled!==false).length+' 个<br>积分调用开关不等于自动签到或自动任务开关；未知积分不按零计。</p></section><div class="m-master-detail"><section class="m-master"><div class="m-master-head"><span>'+items.length+' 个匹配账号</span><span>每页 '+state.pageSize+' 个</span></div><div role="listbox" aria-label="WorkBuddy账号目录">'+(list.length?list.map(a=>'<button class="m-list-item '+(idOf(a)===String(state.selected)?'is-selected':'')+'" role="option" aria-selected="'+(idOf(a)===String(state.selected))+'" tabindex="'+(idOf(a)===String(state.selected)?0:-1)+'" type="button" data-wb-select="'+esc(idOf(a))+'"><span class="m-account-mark">WB</span><span class="m-list-copy"><strong>'+esc(labelOf(a))+'</strong><small>'+esc(a.edition||'cn')+' · '+esc(a.current?'当前登录':a.inferenceEnabled===false?'积分调用已停用':statusText(a.usageStatus||'saved'))+'</small></span><span class="m-list-amount">'+esc(fmt(a.remaining??obj(a.balance).value))+'</span></button>').join(''):empty('没有匹配账号','添加登录或导入账号后将显示在此。'))+'</div><div class="m-pager"><button class="button" data-m-page="'+(state.page-1)+'" '+(state.page<=1?'disabled':'')+'>上一页</button><span>'+state.page+' / '+pageCount+'</span><button class="button" data-m-page="'+(state.page+1)+'" '+(state.page>=pageCount?'disabled':'')+'>下一页</button></div></section><section id="wbDetailPane" class="m-detail" data-selected-account="'+esc(a?idOf(a):'')+'">'+(a?wbDetail(a):empty('选择一个账号','翻页和选择只浏览；“切换此号”才改变客户端登录。'))+'</section></div>';}
  function wbDetail(a){const id=idOf(a),balance=obj(a.balance),tasks=obj(a.tasks);const profile='<div class="m-detail-balance"><p>账号积分 · '+esc(a.stale?'上次记录':'当前读取结果')+'</p><strong>'+esc(fmt(a.remaining??balance.value))+'</strong><span>/ '+esc(fmt(a.total))+'</span></div>'+facts([['账号ID',id],['UID',obj(a.identity).uid??obj(a.profile).uid??a.uid],['版本',a.edition],['凭据状态',statusText(a.credentialStatus)],['积分调用',a.inferenceEnabled!==false],['账号启用',a.enabled!==false],['记录时间',time(a.checkedAt||a.lastSuccessAt)],['备注',a.notes]])+'<div class="m-secondary-actions">'+link('wb.profile','修改名称与备注',id,{label:a.label||'',notes:a.notes||''})+link('wb.markStatus','标记 / 清除封禁',id,{status:obj(a.ban).source==='manual'?'clear':'banned',confirm:true})+link('wb.export','导出此号',id)+link('account.delete','删除账号',id)+'</div>';let body=profile+packagePanel(a);if(state.tab==='tasks'){const extra=obj(state.extra),items=arr(extra.tasks??obj(extra.snapshot).tasks??tasks.tasks??tasks.items);body='<div class="m-toolbar-actions">'+button('wb.tasks','接受任务',id,{action:'accept'})+button('wb.tasks','执行可自动任务',id,{action:'run'})+button('wb.tasks','领取任务结果',id,{action:'claim'})+'<button class="button" type="button" data-m-read-view="tasks" data-m-account="'+esc(id)+'">读取任务状态</button></div>'+(items.length?items.map(t=>'<article class="m-task-row"><h3>'+esc(t.title||t.name||t.taskCode||t.id||'积分任务')+'</h3><p>'+esc(t.description||t.message||t.status||'')+'</p><footer><span>'+esc(t.credits??t.reward??'奖励以官方回执为准')+'</span>'+button('wb.tasks','执行此任务',id,{action:'run',taskCode:t.taskCode||t.code||t.id||''})+'</footer></article>').join(''):'<p class="m-empty-note">当前缓存没有任务条目，可主动读取或接受平台任务。</p>')+jobPanel()+resultFacts(state.extra);}else if(state.tab==='rotation'){body='<div class="m-toolbar-actions">'+button('wb.rotation','修改轮换策略','',obj(obj(state.extra).settings))+button('wb.rotationEvaluate','只读预览','',{dryRun:true})+button('wb.rotationEvaluate','立即评估','',{dryRun:false})+button('wb.pool','配置路由账号池')+button('wb.poolSelect','选择此号用于路由',id)+'</div>'+facts(Object.entries(obj(obj(state.extra).settings)).map(([k,v])=>[fieldLabels[k]||k,v]));}else if(state.tab==='models'){body=table([['模型','model',r=>esc(r.exactModel||r.model)],['版本','edition'],['参与账号','accountIds',r=>esc(arr(r.accountIds).length+' 个')]],rows('models'));}return '<header class="m-detail-heading"><div><h2>'+esc(labelOf(a))+'</h2><p>'+esc(id)+' · '+esc(a.edition||'cn')+'</p></div>'+badge(a.current?'当前登录':a.inferenceEnabled===false?'推理已停用':'已保存',a.current?'ok':'neutral')+'</header><div class="m-quick-actions">'+button('wb.switch','切换此号',id,{switchClient:true,migrate:settingsDefault('autoMigrateSessions')})+button('wb.inference',a.inferenceEnabled===false?'启用积分调用':'停用积分调用',id,{enabled:a.inferenceEnabled===false})+button('wb.refresh','刷新此号',id)+button('wb.merge','合并聊天副本',id,{targetAccountId:id})+'</div>'+secondaryTabs([['profile','账号资料'],['tasks','积分任务'],['rotation','轮换与路由池'],['models','模型']])+body;}
  function settingsDefault(name){return obj(obj(state.data).settings)[name]===true;}
  function fieldHint(desc){const text=String(desc);let match=text.match(/text\s*(\d+)/);if(match)return '最多 '+match[1]+' 个字符。';match=text.match(/(?:int|number)\s*(-?[\d.]+)\.\.(-?[\d.]+)/);if(match)return '取值范围 '+match[1]+' 至 '+match[2]+(/int/.test(text)?'，使用整数。':'。');if(/array/.test(text))return '高级列表参数，使用 JSON 数组；只提交当前列出的字段。';if(/\{|object/.test(text))return '高级对象参数，使用 JSON 对象。';if(/id/.test(text))return '填写后台已有标识，或为新增项指定唯一标识。';return '按当前配置填写；未确认前不会提交。';}
  function optionText(value){return ({cn:'国内版（cn）',ai:'国际版（ai）',global:'国际版',intl:'国际版',all:'全部',selected:'选中路由',models:'模型条目',run:'执行任务',accept:'接受任务',claim:'领取任务结果',query:'查询',banned:'标记已封禁',clear:'清除标记',gateway:'网关',both:'网关与命令行','codebuddy-cli':'CodeBuddy 命令行',expiry:'临期优先',round_robin:'轮转',configured:'按配置',stable:'稳定优先',fast:'速度优先',desktop:'客户端当前登录',file:'凭据文件',skip:'跳过重复',replace:'替换重复',json:'JSON 文件',zip:'ZIP 账号包','switch-json':'切换器 JSON'})[value]||value;}
  function packagePanel(a){const packages=arr(obj(a.balance).packages);return '<div class="m-section-title"><h3>额度套餐与到期</h3><span class="m-overline">'+packages.length+' 项</span></div>'+(packages.length?table([['套餐','name',r=>esc(r.name||r.packageName||r.id)],['剩余 / 总额','remaining',r=>esc(fmt(r.remaining??r.balance))+' / '+esc(fmt(r.total))],['到期','expiresAt',r=>esc(time(r.expiresAt))],['状态','status',r=>badge(statusText(r.status),'neutral')]],packages):'<p class="m-empty-note">当前记录没有套餐明细。</p>');}
  function upstreamPanel(){const items=rows('upstreams');return '<section class="m-settings-section"><div class="m-section-title"><h2>模型上游与来源</h2><div class="m-toolbar-actions">'+button('upstream.save','添加上游')+button('freeProvider.add','添加免费来源')+'<button class="text-button" data-m-read-view="freeProviders">读取来源目录</button></div></div>'+table([['上游','id'],['类型 / 账号','kind',r=>esc(r.kind)+'<small>'+esc(r.accountId||'')+'</small>'],['状态','enabled',r=>badge(r.enabled===false?'停用':'启用','neutral')],['管理','',r=>'<div class="m-cell-actions">'+link('upstream.save','编辑','',r)+link('upstream.delete','删除','',{id:r.id})+'</div>']],items)+'</section>';}
  function loginPanel(){const login=obj(state.login);if(!login.loginId)return '';const status=login.status||'等待官方登录';return '<section class="m-login-state"><div class="m-section-title"><h3>官方登录进度</h3>'+badge(status,['completed','saved','success'].includes(status)?'ok':'info')+'</div><p class="m-overline">官方登录页面由宿主打开。完成登录后在这里检查结果；关闭或翻页不会伪造登录成功。</p>'+facts([['登录任务',login.loginId],['有效期',time(login.expiresAt)],['账号',login.accountId]])+'<div class="m-quick-actions">'+button('wb.loginPoll','检查登录结果','',{loginId:login.loginId})+button('wb.loginCancel','取消本次登录','',{loginId:login.loginId})+'</div></section>';}
  function importPanel(){if(!importPayload||state.result?.operation?.kind!=='wb.importPreview')return '';const extra=obj(state.extra),preview=obj(typeof extra.preview==='object'&&extra.preview?extra.preview:extra),entries=arr(preview.entries);return '<section class="m-login-state"><div class="m-section-title"><h3>导入预览</h3><span class="m-overline">'+entries.length+' 项</span></div><p class="m-overline">选择有效条目，再确认导入。替换/跳过策略在提交时选择；预览不保存账号。</p><div class="m-table-wrap"><table class="m-table"><thead><tr><th>选择</th><th>账号 / 版本</th><th>状态</th><th>说明</th></tr></thead><tbody>'+entries.map((item,i)=>'<tr><td><input type="checkbox" data-import-index="'+(item.index??i)+'" '+(item.valid===false?'disabled':'checked')+' aria-label="选择导入项'+(i+1)+'"></td><td>'+esc(item.label||'账号 '+(i+1))+'<small>'+esc(item.edition||'')+'</small></td><td>'+badge(item.valid===false?'无效':item.existing?'已存在':'可导入',item.valid===false?'error':'neutral')+'</td><td>'+esc(arr(item.errors).join('；')||item.message||'')+'</td></tr>').join('')+'</tbody></table></div><div class="m-quick-actions"><button class="button button-primary" data-m-import-commit '+(!entries.some(x=>x.valid!==false)||state.busy?'disabled':'')+'>提交选中账号</button><button class="button" data-m-import-discard>放弃本次导入</button></div></section>';}
  function jobPanel(){const job=obj(state.job),id=job.jobId||job.id;if(!id)return '';return '<section class="m-login-state"><div class="m-section-title"><h3>积分任务进度</h3>'+badge(job.status||'待核对','info')+'</div><p class="m-overline">任务 '+esc(id)+' · 查询进度不会重新提交任务。</p><div class="m-quick-actions"><button class="button" data-m-job-read="'+esc(id)+'">读取任务进度</button>'+button('wb.tasksCancel','取消任务等待','',{jobId:id})+'</div></section>';}
  function renderAccounts(){const items=filtered(rows('accounts'));return toolbar([button('account.add','添加账号')])+table([['平台与账号','label',a=>'<strong>'+esc(labelOf(a))+'</strong><small>'+esc(a.platform)+' · '+esc(a.id)+'</small>'],['状态','enabled',a=>badge(a.enabled===false?'停用':'启用',a.enabled===false?'neutral':'ok')],['登录来源','credentialConfigured',a=>esc(a.credentialConfigured?'已配置':'待配置')+'<small>'+esc(a.edition||'')+'</small>'],['任务','tasks',a=>esc(arr(a.tasks).filter(t=>t.enabled!==false).length+' 项启用')],['管理','',a=>'<div class="m-cell-actions">'+link('account.update','资料',a.id,a)+link('account.enable',a.enabled===false?'启用':'停用',a.id,{enabled:a.enabled===false})+link('account.tasks','任务',a.id,{tasks:arr(a.tasks)})+link('account.delete','删除',a.id)+'</div>']],items)+(items.length?'':empty('暂无账号配置'));}
  function renderRoutes(){const data=obj(state.data),items=filtered(arr(data.routes));return toolbar([button('route.save','添加路由'),button('models.directory','刷新模型目录'),button('models.test','模型体检'),button('models.import','导入模型'),button('models.export','移出已导入模型')])+table([['路由 / 模型','name',r=>'<strong>'+esc(r.name||r.id)+'</strong><small>'+esc(r.id)+'</small>'],['目标','targets',r=>arr(r.targets).map(t=>esc(t.upstreamId)+' / '+esc(t.model)).join('<br>')],['配置状态','enabled',r=>badge(r.enabled===false?'停用':'启用',r.enabled===false?'neutral':'ok')],['管理','',r=>'<div class="m-cell-actions">'+link('route.save','编辑','',r)+link('route.enable',r.enabled===false?'启用':'停用','',{id:r.id,enabled:r.enabled===false})+link('route.reorder','接力次序','',{routeId:r.id,expectedTargets:r.targets,targets:r.targets})+link('route.delete','删除','',{id:r.id})+'</div>']],items)+'<section class="m-settings-section"><div class="m-section-title"><h2>模型目录与体检</h2><div class="m-toolbar-actions"><button class="text-button" data-m-read-view="directory">读取模型目录</button><button class="text-button" data-m-read-view="audit">读取体检结果</button></div></div>'+genericReport(state.extra||data.directory||data.audit)+'</section>'+upstreamPanel();}
  function renderRecords(){const data=obj(state.data),items=filtered(arr(data.records??data.calls??data.items));return toolbar([],true)+'<nav class="m-tabs"><button class="'+(state.view!=='usage'?'is-active':'')+'" data-m-read-view="claims">领取回执</button><button class="'+(state.view==='usage'?'is-active':'')+'" data-m-read-view="usage">调用记录</button></nav>'+table([['北京时间','time',r=>esc(time(r.time||r.createdAt||r.at))+'<small>#'+esc(r.id)+'</small>'],['平台 / 账号','platform',r=>'<strong>'+esc(r.accountLabel||r.platform||'未记录账号')+'</strong><small>'+esc(r.accountId||r.platform||'')+'</small>'],['结果 / 来源','status',r=>badge(statusText(r.status),['error','failed','rejected'].includes(r.status)?'error':'neutral')+'<small>'+esc(obj(r.result).trigger==='automatic'?'自动任务':obj(r.result).trigger==='manual'?'手动任务':r.task==='daily-checkin'?'每日签到':r.task||'后台任务')+'</small>'],['回执说明','message',r=>esc(r.message||r.summary||receiptReason(obj(r.result).reason,r.status))],['额度 / 用量','credits',r=>esc(fmt(r.credits??r.amount??obj(r.result).credits??r.totalTokens))+'<small>'+esc(obj(r.result).automaticRewardConfirmed===true?'自动奖励已有确认':'历史回执不计作本轮新增')+'</small>']],items)+(items.length?'':empty('当前没有记录'));}
  function renderPreferences(){const d=obj(state.data);return toolbar([],false)+'<div class="m-panel-columns"><section class="m-settings-section"><h2>自动签到计划</h2><p>控制现有后台的计划与重试；与界面自动读取不同。</p>'+facts(Object.entries(obj(d.scheduler)).map(([k,v])=>[fieldLabels[k]||k,v]))+'<div class="m-quick-actions">'+button('scheduler.save','修改签到计划','',obj(d.scheduler))+'</div></section><section class="m-settings-section"><h2>服务与模型接力</h2><p>服务监听、保留预算与分区接力。</p>'+facts(Object.entries(obj(d.server)).map(([k,v])=>[fieldLabels[k]||k,v]))+'<div class="m-quick-actions">'+button('server.save','修改监听设置','',obj(d.server))+button('relay.save','模型接力策略','',obj(d.modelRelay))+'</div>'+facts(Object.entries(obj(d.modelRelay)).map(([k,v])=>[fieldLabels[k]||k,v]))+'</section></div><section class="m-settings-section"><h2>WorkBuddy 自动任务</h2><p>自动任务、积分调用和定时签到是独立开关。</p>'+facts(Object.entries(obj(d.workbuddy)).map(([k,v])=>[fieldLabels[k]||k,v]))+'<div class="m-quick-actions">'+button('wb.settings','修改账号池设置','',obj(d.workbuddy))+'</div></section>';}
  function renderDiagnostics(){const data=obj(state.extra||state.data),items=filtered(arr(data.items??data.requests??data.results));return toolbar([button('diagnostics.doctor','检查认证来源'),button('diagnostics.health','核验账号连接'),button('diagnostics.rebind','重新绑定'),button('diagnostics.routePreview','路由决策预览'),button('diagnostics.restartDsh','重载 DSH 接力')])+secondaryTabs([['profile','诊断上下文'],['requests','请求轨迹'],['activation','客户端激活'],['audit','模型体检']])+(items.length?table([['北京时间','time',r=>esc(time(r.time||r.startedAt||r.createdAt))],['请求 / 模型','model',r=>'<strong>'+esc(r.model||r.routeId||'请求')+'</strong><small>'+esc(String(r.id||r.requestId||'').replace(/^request:/,''))+'</small>'],['来源','source',r=>esc(r.source?statusText(r.source):'未记录')],['请求结果','status',r=>badge(statusText(r.status),['error','failed','rejected'].includes(r.status)?'error':'neutral')],['详情','',r=>'<button class="text-button" data-m-request-id="'+esc(String(r.requestId||r.id||'').replace(/^request:/,''))+'">请求详情</button>']],items):genericReport(data))+'<p class="m-json-note">当前 '+items.length+' 条请求 · '+arr(data.models).length+' 个模型。详情可查看机器错误码，主列表只展示可读状态。</p>';}
  function renderUpdates(){const data=obj(state.data),items=filtered(arr(data.targets??data.clients??data.items??data.results));return toolbar([button('updates.check','检查全部更新','',{failedOnly:false}),button('updates.check','只重查失败项','',{failedOnly:true}),button('updates.settings','检查策略','',{enabled:data.enabled,intervalHours:data.intervalHours,timeoutMs:data.timeoutMs})])+table([['客户端','name',r=>'<strong>'+esc(r.name||r.label||r.id||r.targetId)+'</strong><small>'+esc(r.note||'')+'</small>'],['当前版本','version',r=>esc(r.installed||r.currentVersion||r.installedVersion||r.version||'未识别')],['最新版本','latestVersion',r=>esc(r.latest||r.latestVersion||r.availableVersion||'待检查')],['检查结果','status',r=>badge(statusText(r.status),r.status==='update_available'?'info':['error','failed'].includes(r.status)?'error':'neutral')+'<small>'+esc(time(r.checkedAt))+'</small>'],['管理','',r=>'<div class="m-cell-actions">'+button('updates.check','重新检查','',{targetIds:[r.id||r.targetId],failedOnly:false})+'<button class="text-button" data-m-client="client.open" data-m-target="'+esc(r.id||r.targetId)+'">打开软件</button><button class="text-button" data-m-client="client.shortcut" data-m-target="'+esc(r.id||r.targetId)+'">桌面快捷方式</button>'+(r.downloadUrl?'<button class="text-button" data-m-copy="'+esc(r.downloadUrl)+'">复制下载链接</button>':'')+'</div>']],items)+(items.length?'':genericReport(data));}
  function renderOperations(){const data=obj(state.data),notifications=arr(data.notifications),keys=arr(obj(state.extra).keys??data.keys);return toolbar([button('operations.settings','运行策略','',obj(data.settings)),button('operations.keyCreate','创建应用密钥')],false)+'<section class="m-settings-section"><div class="m-section-title"><h2>上游与调用状态</h2><span class="m-overline">'+arr(data.health).length+' 项</span></div>'+healthTable(arr(data.health))+'</section><div class="m-panel-columns"><section class="m-settings-section"><h2>当前运行策略</h2>'+facts(Object.entries(obj(data.settings)).map(([k,v])=>[fieldLabels[k]||k,v]))+resultFacts(data.sessionSummary)+'</section><section class="m-settings-section"><h2>通知中心</h2>'+(notifications.length?notifications.map(n=>'<article class="m-notification"><div><h3>'+esc(n.title||'运行通知')+'</h3><p>'+esc(n.message||n.body||'')+'</p><p>'+esc(time(n.createdAt||n.at))+'</p></div>'+(n.read?badge('已读','neutral'):link('operations.notificationRead','标记已读','',{id:n.id}))+'</article>').join(''):'<p class="m-empty-note">暂无运行通知。</p>')+'</section></div><section class="m-settings-section"><div class="m-section-title"><h2>应用密钥</h2><button class="text-button" data-m-read-view="keys">重新读取元数据</button></div>'+table([['名称','name',k=>esc(k.name||k.label||k.id)],['标识','id'],['状态','enabled',k=>esc(k.enabled===false?'停用':'启用')],['管理','',k=>link('operations.keyRevoke','撤销','',{id:k.id})]],keys)+'<p class="m-json-note">只展示密钥元数据；新密钥由宿主保存文件，不在页面回显完整内容。</p></section>';}
  function safePairs(data){return Object.entries(obj(data)).filter(([k,v])=>!/(token|cookie|authorization|secret|password|content|access.?key)/i.test(k)&&(!v||typeof v!=='object')).slice(0,25).map(([k,v])=>[fieldLabels[k]||k,v]);}
  function resultFacts(data){if(!data)return '';const pairs=safePairs(data);return pairs.length?'<div class="m-result-facts">'+facts(pairs)+'</div>':'';}
  function genericReport(data){if(!data)return '<p class="m-empty-note">选择上方操作或读取更多状态。</p>';const d=obj(data),arrays=Object.entries(d).filter(([k,v])=>Array.isArray(v)&&!/(token|cookie|secret|content)/i.test(k));let html=resultFacts(d);for(const [key,items]of arrays.slice(0,4)){if(!items.length)continue;const keys=[...new Set(items.flatMap(x=>Object.keys(obj(x))))].filter(k=>!/(token|cookie|authorization|secret|password|content|access.?key)/i.test(k)).slice(0,5);html+='<div class="m-section-title"><h3>'+esc(fieldLabels[key]||key)+'</h3><span class="m-overline">'+items.length+' 条</span></div>'+table(keys.map(k=>[fieldLabels[k]||k,k]),items);}return html||'<p class="m-empty-note">后台已返回状态，当前没有可列出的条目。</p>';}
  function render(){if(!state.section)return '';const meta=sections[state.section],nav='<nav class="management-nav" aria-label="管理工作区">'+Object.entries(sections).map(([section,[label]])=>'<button type="button" data-m-nav="'+section+'" class="'+(state.section===section?'is-active':'')+'">'+label+'</button>').join('')+'</nav>';const body=state.loading&&!state.data?'<div class="loading-state"><div class="skeleton skeleton-title"></div><p>正在读取'+esc(meta[0])+'…</p></div>':({accounts:renderAccounts,routes:renderRoutes,records:renderRecords,preferences:renderPreferences,diagnostics:renderDiagnostics,workbuddy:renderWB,updates:renderUpdates,operations:renderOperations})[state.section]();return '<div class="page-container management-page"><header class="page-heading"><div><h1>'+esc(meta[0])+'</h1><p>'+esc(meta[1])+'</p></div><button class="text-button" data-m-home type="button">返回总览'+ctx.icon('arrow')+'</button></header>'+nav+'<div id="managementContent" data-management-section="'+state.section+'">'+status()+body+'</div></div>';}
  async function read(view='',accountId=''){const seq=++readSequence;state.loading=true;state.error='';ctx.paint();try{const params={section:state.section,limit:200,...(view?{view}:{}),...(accountId?{accountId}:{})};const result=await ctx.bridge('management.read',params);if(['failed','uncertain'].includes(result.operation?.status))throw new Error(result.operation.message||'读取管理数据失败。');if(seq!==readSequence)return;if(result.revision)state.revision=result.revision;const mainView=!view||['summary','config','list','claims','report','context','usage'].includes(view);if(mainView){state.data=obj(result.data??result);state.view=view;}else{state.extra=result.data??result;state.view=view;}if(state.section==='workbuddy'&&!state.selected)state.selected=obj(state.data).currentAccountId||idOf(allAccounts()[0]||{});}catch(error){if(seq===readSequence)state.error=error?.message||'读取失败，请重试。';}finally{if(seq===readSequence){state.loading=false;ctx.paint();}}}
  async function open(section){if(!sections[section])return;state.section=section;state.data=null;state.extra=null;state.query='';state.page=1;state.selected=null;state.tab='profile';state.view='';state.result=null;await read();}
  function repaintSearch(){const focused=document.activeElement?.id==='managementSearch',caret=focused?document.activeElement.selectionStart:null;ctx.paint();if(focused){$('#managementSearch')?.focus({preventScroll:true});try{$('#managementSearch').setSelectionRange(caret,caret);}catch{}}}
  function init(options){ctx=options;const dialog=document.createElement('dialog');dialog.id='managementActionDialog';dialog.className='dialog m-action-dialog';dialog.setAttribute('aria-labelledby','managementActionTitle');dialog.innerHTML='<form id="managementActionForm"><div class="dialog-header"><div><h2 id="managementActionTitle"></h2><p id="managementActionScope"></p></div><button class="icon-button" type="button" data-m-close aria-label="关闭操作">'+ctx.icon('close')+'</button></div><div id="managementActionBody" class="m-action-body"></div><div class="dialog-footer"><button class="button" type="button" data-m-close>取消</button><button class="button button-primary" type="submit" id="managementActionSubmit">确认执行</button></div></form>';document.body.append(dialog);$('#managementActionForm').addEventListener('submit',submitAction);dialog.addEventListener('close',()=>{state.dialog=null;$('#managementActionBody').innerHTML='';});document.addEventListener('click',handleClick);document.addEventListener('input',ev=>{if(ev.target.id==='managementSearch'){state.query=ev.target.value.trim();state.page=1;repaintSearch();}});document.addEventListener('keydown',handleKey);}
  function formDefault(field,values,account){if(Object.prototype.hasOwnProperty.call(values,field))return values[field];if(field==='accountId')return account||state.selected||'';if(field==='enabled')return true;if(field==='format')return 'json';if(field==='duplicatePolicy')return 'skip';if(field==='scope')return 'all';if(field==='dryRun')return true;if(field==='edition')return 'cn';if(field==='switchClient')return true;if(field==='timezone')return 'Asia/Shanghai';if(field==='tasks')return [];if(field==='targets'||field==='expectedTargets'||field==='items'||field==='routeIds'||field==='taskCodes'||field==='targetIds'||field==='allowedModels')return [];return '';}
  function fieldHtml(name,type,value,where='values'){const label=fieldLabels[name]||name,desc=typeof type==='string'?type:JSON.stringify(type),required=desc.includes('required'),attrs='name="'+esc(name)+'" data-m-field="'+esc(name)+'" data-m-where="'+where+'" '+(required?'required ':'');if(name==='content')return '<label class="m-field wide"><span>导入文件 · JSON / ZIP</span><input type="file" id="managementImportFile" accept=".json,.zip" required><small>内容只用于此次预览与提交，不写入浏览器偏好。</small></label>';if(/^(?:required )?bool/.test(desc))return '<label class="m-field is-check"><input type="checkbox" '+attrs+' '+(value===true?'checked':'')+'><span>'+esc(label)+'</span></label>';if(name==='routeIds'){const choices=rows('routes');return '<label class="m-field wide"><span>路由选择</span><select '+attrs+' multiple size="6">'+choices.map(r=>'<option value="'+esc(r.id)+'" '+(arr(value).includes(r.id)?'selected':'')+'>'+esc(r.name||r.id)+'</option>').join('')+'</select><small>可多选已配置路由。</small></label>';}if(name==='accountId'||name==='accountIds'){const multiple=name==='accountIds';return '<label class="m-field"><span>'+esc(label)+'</span><select '+attrs+' '+(multiple?'multiple size="5"':'')+'>'+allAccounts().map(a=>'<option value="'+esc(idOf(a))+'" '+((multiple?arr(value).includes(idOf(a)):String(value)===idOf(a))?'selected':'')+'>'+esc(labelOf(a))+' · '+esc(idOf(a))+'</option>').join('')+'</select></label>';}const enumText=desc.replace(/required /g,'').replace(/ optional/g,'');if(enumText.includes('|')&&!enumText.includes('array')&&name!=='host'){const choices=enumText.split('|').map(x=>x.split(' ')[0]);return '<label class="m-field"><span>'+esc(label)+'</span><select '+attrs+'>'+choices.map(v=>'<option value="'+esc(v)+'" '+(String(value)===v?'selected':'')+'>'+esc(optionText(v))+'</option>').join('')+'</select></label>';}if(/array|\{|object/.test(desc)||typeof value==='object'){return '<label class="m-field wide"><span>'+esc(label)+'</span><textarea '+attrs+' data-m-type="json" spellcheck="false">'+esc(JSON.stringify(value===''?(/array/.test(desc)?[]:{}):value,null,2))+'</textarea><small>'+esc(fieldHint(desc))+'</small></label>';}const number=/int|number/.test(desc);return '<label class="m-field '+(name==='notes'?'wide':'')+'"><span>'+esc(label)+(required?' *':'')+'</span><input '+attrs+' type="'+(number?'number':/apiKey|token|password|secret/i.test(name)?'password':'text')+'" '+(number?'step="'+(/int/.test(desc)?'1':'any')+'"':'')+' value="'+esc(value)+'" '+(/token|password|secret/i.test(name)?'autocomplete="off"':'')+'><small>'+esc(fieldHint(desc))+'</small></label>';}
  function openAction(action,account='',values={},top={}){if(state.busy||ctx?.busy?.()||!CONTRACT.actions[action])return;const schema=CONTRACT.actions[action];state.dialog={action,account,values:obj(values),top,schema};$('#managementActionTitle').textContent=labels[action]||action;$('#managementActionScope').textContent=account?(labelOf(allAccounts().find(a=>idOf(a)===String(account))||{id:account})+' · '+account):sections[state.section]?.[0]||'管理操作';const fields=[];if(schema.accountId&&!account)fields.push(fieldHtml('accountId',schema.accountId,formDefault('accountId',values,account),'top'));if(schema.accountIds)fields.push(fieldHtml('accountIds',schema.accountIds,top.accountIds|| (account?[account]:[]),'top'));if(schema.routeIds)fields.push(fieldHtml('routeIds',schema.routeIds,top.routeIds||[],'top'));if(schema.jobId)fields.push(fieldHtml('jobId',schema.jobId,top.jobId||values.jobId||obj(state.extra).jobId||obj(state.extra).id||obj(obj(state.extra).job).id||'','top'));if(schema.content&&!top.content)fields.push(fieldHtml('content',schema.content,'' ,'top'));if(schema.items)fields.push(fieldHtml('items',schema.items,top.items||[],'top'));for(const [name,type]of Object.entries(obj(schema.values)))fields.push(fieldHtml(name,type,formDefault(name,values,account)));$('#managementActionBody').innerHTML='<p>'+esc(action==='account.delete'?'删除将清理账号引用，来源记录按现有后台规则保留。请核对账号。':action==='models.export'?'该操作停用所选已导入路由，不下载文件。':action==='wb.switch'?'此操作将改变客户端当前登录；仅浏览目录不会切换。':action==='wb.export'?'导出包含登录凭据，文件由宿主保存到本机，不在页面显示完整凭据。':'核对以下参数后确认执行。未确认前不发送后台动作，失败不自动重放。')+'</p><div class="m-form-grid">'+fields.join('')+'</div><p class="m-form-error" id="managementFormError" hidden></p>';$('#managementActionSubmit').disabled=false;$('#managementActionDialog').showModal();}
  async function submitAction(event){event.preventDefault();if(state.busy||ctx?.busy?.()||!state.dialog)return;const dialog=state.dialog;if(['client.open','client.shortcut'].includes(dialog.action)){$('#managementActionSubmit').disabled=true;await actClient(dialog.action,dialog.top.targetId);$('#managementActionDialog').close();return;}const body=$('#managementActionBody'),values={},request={action:dialog.action,confirmed:true,...(state.revision?{revision:state.revision}:{}),...(dialog.account?{accountId:dialog.account}:{}),...dialog.top};try{for(const input of $$('[data-m-field]',body)){let value=input.type==='checkbox'?input.checked:input.multiple?[...input.selectedOptions].map(o=>o.value):input.dataset.mType==='json'?JSON.parse(input.value||'null'):input.type==='number'?input.value===''?undefined:Number(input.value):input.value;if(value===''||value===undefined)continue;if(input.dataset.mWhere==='top')request[input.name]=value;else values[input.name]=value;}if(dialog.schema.content&&!request.content){const file=$('#managementImportFile')?.files?.[0];if(!file)throw new Error('请选择导入文件。');if(file.size>6*1024*1024)throw new Error('导入文件超过6MiB。');if(file.name.toLowerCase().endsWith('.zip')){const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));request.content=btoa(raw);values.format='zip';}else{request.content=await file.text();values.format='json';}if(new TextEncoder().encode(request.content).length>6*1024*1024)throw new Error('导入文件编码后超过6MiB，请减少文件大小。');if(dialog.action==='wb.importPreview')importPayload={content:request.content,format:values.format};}request.values=values;$('#managementActionSubmit').disabled=true;await act(request);if(state.result?.operation?.status!=='failed')$('#managementActionDialog').close();else $('#managementActionSubmit').disabled=false;}catch(error){$('#managementFormError').hidden=false;$('#managementFormError').textContent=error.message||'输入无效，请核对。';$('#managementActionSubmit').disabled=false;}}
  async function act(request){if(state.busy||ctx?.busy?.())return;state.busy=true;state.error='';ctx.paint();try{const result=await ctx.bridge('management.action',request);state.result=result;if(request.action==='wb.importCommit'&&result.operation?.status==='completed')importPayload=null;if(result?.snapshot)ctx.onSnapshot(result.snapshot);if(result?.data){state.extra=result.data;const data=obj(result.data);if(request.action==='wb.loginCancel')state.login=null;if(request.action==='wb.loginStart'||request.action==='wb.loginPoll')state.login={...obj(state.login),...data};if(request.action==='wb.tasks')state.job=data;if(request.action==='wb.importPreview'){state.tab='import';}else if(result.operation?.status==='completed'&&!['wb.export','wb.loginStart','wb.loginPoll','wb.loginCancel','wb.tasks','wb.rotationEvaluate','diagnostics.doctor','diagnostics.health','diagnostics.routePreview','models.directory','models.test'].includes(request.action)){await read();}}}catch(error){state.error=(error?.message||'后台操作结果未返回。')+' 本窗口未自动重试，请先核对记录。';}finally{state.busy=false;ctx.paint();}}
  function handleClick(event){const b=event.target.closest('button');if(!b)return;if(b.dataset.mClient)return openClient(b.dataset.mClient,b.dataset.mTarget);if(b.hasAttribute('data-m-import-discard')){importPayload=null;state.extra=null;ctx.paint();return;}if(b.hasAttribute('data-m-import-commit')){const indexes=$$('[data-import-index]:checked').map(n=>Number(n.dataset.importIndex));if(!importPayload||!indexes.length){ctx.toast('请选择有效导入项。');return;}return openAction('wb.importCommit','',{format:importPayload.format,duplicatePolicy:'skip',selectedIndexes:indexes},{content:importPayload.content});}if(b.dataset.mJobRead){readJob(b.dataset.mJobRead);return;}if(b.dataset.mRequestId){readRequest(b.dataset.mRequestId);return;}if(b.dataset.mCopy){navigator.clipboard.writeText(b.dataset.mCopy).then(()=>ctx.toast('已复制下载链接'),()=>ctx.toast('复制未完成，请重试。'));return;}if(b.dataset.mNav)return ctx.navigate('manage-'+b.dataset.mNav);if(b.hasAttribute('data-m-home'))return ctx.navigate('overview');if(b.hasAttribute('data-m-reload'))return read();if(b.dataset.mPage){state.page=Number(b.dataset.mPage);ctx.paint();return;}if(b.dataset.wbSelect){state.selected=b.dataset.wbSelect;state.extra=null;ctx.paint();return;}if(b.dataset.mTab){state.tab=b.dataset.mTab;state.extra=null;if(state.section==='workbuddy'&&state.tab==='rotation')read('rotation');else if(state.section==='diagnostics'&&state.tab!=='profile')read(state.tab);else ctx.paint();return;}if(b.dataset.mReadView)return read(b.dataset.mReadView,b.dataset.mAccount||'');if(b.dataset.mAction){let values={};try{values=JSON.parse(b.dataset.mValues||'{}');}catch{}return openAction(b.dataset.mAction,b.dataset.mAccount||'',values);}if(b.hasAttribute('data-m-close'))$('#managementActionDialog').close();}
  function handleKey(event){const button=event.target.closest('[data-wb-select]');if(button&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=filtered(allAccounts()),at=items.findIndex(a=>idOf(a)===button.dataset.wbSelect);const next=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,at+(event.key==='ArrowDown'?1:-1)));state.selected=idOf(items[next]);state.page=Math.floor(next/state.pageSize)+1;state.extra=null;ctx.paint();$$('[data-wb-select]').find(b=>b.dataset.wbSelect===state.selected)?.focus({preventScroll:true});}}

  async function readJob(jobId){if(state.loading)return;state.loading=true;ctx.paint();try{const result=await ctx.bridge('management.read',{section:'workbuddy',view:'taskJob',jobId});if(['failed','uncertain'].includes(result.operation?.status))throw new Error(result.operation.message||'任务状态读取失败');state.extra=result.data;state.job=result.data;state.tab='tasks';}catch(error){state.error=error.message;}finally{state.loading=false;ctx.paint();}}
  async function readRequest(requestId){if(state.loading)return;state.loading=true;ctx.paint();try{const result=await ctx.bridge('management.read',{section:'diagnostics',view:'requests',requestId});if(['failed','uncertain'].includes(result.operation?.status))throw new Error(result.operation.message||'请求详情读取失败');state.extra=result.data;state.tab='requests';}catch(error){state.error=error.message;}finally{state.loading=false;ctx.paint();}}


  function receiptReason(reason,status){return ({server_already_claimed:'服务端已存在领取回执',already_claimed:'此前已领取',available_before_run:'本轮操作前已存在奖励',newly_granted:'服务端确认当次新增',membership_required:'当前会员权益不满足',no_daily_entitlement:'没有每日领取权益',login_required:'需要更新登录',auth_expired:'登录已过期'})[reason]||statusText(status);}
  function openClient(method,targetId){if(state.busy||ctx?.busy?.())return;state.dialog={action:method,account:'',top:{targetId},values:{},schema:{values:{}}};$('#managementActionTitle').textContent=method==='client.open'?'打开客户端软件':'创建桌面快捷方式';$('#managementActionScope').textContent='更新目标：'+targetId;$('#managementActionBody').innerHTML='<p>'+(method==='client.open'?'宿主将重新核对后台登记的客户端路径后启动软件。':'宿主将按后台登记的目标创建桌面快捷方式。')+' 页面不提供任意路径或命令。</p><p class="m-form-error" id="managementFormError" hidden></p>';$('#managementActionSubmit').disabled=false;$('#managementActionDialog').showModal();}
  async function actClient(method,targetId){if(state.busy||ctx?.busy?.())return;state.busy=true;state.error='';ctx.paint();try{state.result=await ctx.bridge(method,{targetId,confirmed:true});}catch(error){state.error=error.message||'客户端操作未完成。';}finally{state.busy=false;ctx.paint();}}

  window.GatewayManagement={init,open,render,getState:()=>JSON.parse(JSON.stringify({...state,dialog:state.dialog?{action:state.dialog.action,account:state.dialog.account}:null})),sections,openAction,read};
})();
