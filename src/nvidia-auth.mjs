import {hash} from './util.mjs';
// Persistent authentication evidence is scoped to the exact local credential, not just account label.
export function nvidiaAuthState(ledger,accountId,credential,event,now=Date.now()){
 const id='nvidia-auth:'+accountId,fingerprint=hash(credential.accessToken);const old=ledger?.get?.(id);let state=old?.fingerprint===fingerprint?{...old}:{fingerprint,credentialStatus:'unverified',lastAuthenticatedAt:null,lastAuthErrorAt:null};
 if(event==='authenticated'){state.credentialStatus='authenticated';state.lastAuthenticatedAt=new Date(now).toISOString()}
 if(event==='rejected'){state.credentialStatus='rejected';state.lastAuthErrorAt=new Date(now).toISOString()}
 if(old?.fingerprint!==fingerprint||event)ledger?.set?.(id,state);
 const {fingerprint:privateFingerprint,...publicState}=state;return publicState;
}
