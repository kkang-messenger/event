import {hash,messageKey,messageRole} from './core.js';
import {detectPhoneScreen} from './phone-detection.js';
import {choiceMatchesLanguage,localizedChoiceDefaults,localizedControlChoice} from './choice-language.js';

export const CALL_END_LABEL='통화 끊기';
export const CALL_END_CONTROL='[통화 종료] The user explicitly ended this fictional call; the character did not hang up. Treat the visible user message [통화 종료] as the user ending the call. Do not generate another phone screen or claim the character ended it. Continue in the existing messenger or narrative mode with a natural character reaction to the user ending the call. Do not invent any additional user words, actions, thoughts, feelings, or decisions. Preserve the selected body language.';
const VIEW_PHASES={'outgoing-call-view':'dialing','incoming-call-view':'incoming','in-call-view':'connected','call-ended-view':'ended','declined-view':'ended','unanswered-view':'ended'};

// These controls live outside the full JS Runner document. Never touch a fence.
function outsideFences(source,transform){
    const fence=/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\1[ \t]*(?=\n|$)|$)/g;
    let body='',start=0;
    for(const match of source.matchAll(fence)){body+=transform(source.slice(start,match.index))+match[0];start=match.index+match[0].length;}
    return body+transform(source.slice(start));
}
function plainText(source){
    return String(source??'').replace(/```[\s\S]*?```/g,' ')
        .replace(/<messenger_thinking\b[^>]*>[\s\S]*?<\/messenger_thinking\s*>/gi,' ')
        .replace(/<me35_(?:call_)?choices\b[^>]*>[\s\S]*?<\/me35_(?:call_)?choices\s*>/gi,' ')
        .replace(/<div\b[^>]*\b(?:chat-timestamp|custom-chat-timestamp|msg-time|custom-msg-time|chat-time|custom-chat-time)\b[^>]*>[\s\S]*?<\/div>/gi,' ')
        .replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function cleanOptions(values,language='ko'){
    return [...new Set((Array.isArray(values)?values:[]).filter(value=>typeof value==='string')
        .map(value=>value.replace(/<[^>]*>/g,'').replace(/^\s*(?:\d+[.)]|[①②③④])\s*/u,'').replace(/\s+/g,' ').trim().slice(0,240))
        .filter(value=>value&&value!==localizedControlChoice('call',language)&&!/^(?:\[통화\s*종료\]|(?:통화|전화)\s*(?:끊기|종료|끝내기)$|\/|javascript:|data:)/iu.test(value)
            &&(language==='ko'||choiceMatchesLanguage(value,language))))].slice(0,3);
}
export function splitCallChoices(raw){
    let hadBlock=false,payload='';
    const body=outsideFences(String(raw??''),part=>part.replace(/<me35_call_choices\b[^>]*>([\s\S]*?)<\/me35_call_choices\s*>/gi,(_,value)=>{
        hadBlock=true;payload=value.trim();return '';
    }).replace(/<me35_call_choices\b[^>]*>([^\n]*)(?:\n|$)/gi,(_,value)=>{
        // A truncated single-line block must not eat a subsequent story paragraph.
        hadBlock=true;payload=value.trim();return '';
    }));
    let values=[];
    try{const parsed=JSON.parse(payload.replace(/^```(?:json)?\s*|\s*```$/gi,''));values=Array.isArray(parsed)?parsed:parsed?.choices;}catch{}
    return {body,hadBlock,choices:cleanOptions(values)};
}
function callEnded(text){
    if(/(?:電話|通話)(?:を|が)?(?:切った|切れた|終了した|終わった)[。.!！]?$|通話終了/u.test(text))return true;
    if(/(?:끊겼|종료됐|끝났)(?:나요|어\?|어요\?|는지)|(?:끊지\s*않|끊을\s*생각|끊을까|끊으면|끊기면)/u.test(text))return false;
    return /\[통화\s*종료\]|(?:통화|전화)(?:가|는|를|를\s*이제|을)?\s*(?:종료되었|종료됐|종료했다|종료한다|끝났|끝났다|끊겼|끊어졌|끊었다|끊는다)|(?:통화|전화)\s*종료\s*(?:버튼을|버튼을\s*직접)\s*눌렀|\b(?:call (?:has |is )?(?:ended|disconnected)|hung up (?:the phone|on))\b/iu.test(text);
}
function viewHidden(opening,id,css){
    const attributes=opening.slice(opening.indexOf(' '));
    if(/\bhidden(?:\s|>|=)|\baria-hidden\s*=\s*["']true["']/i.test(attributes))return true;
    const inline=attributes.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]??'';
    if(/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(inline))return true;
    if(/display\s*:\s*(?:flex|block|grid|inline)/i.test(inline))return false;
    const classes=(attributes.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]??'').split(/\s+/u);
    if(classes.includes('hidden')||classes.includes('inactive'))return true;
    if(classes.includes('active')||classes.includes('visible'))return false;
    // Full documents commonly hide inactive views through an ID or .view rule.
    let display=null,specificity=-1;
    for(const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
        const value=rule[2].match(/(?:^|;)\s*display\s*:\s*([^;}]+)/i)?.[1]?.trim().replace(/\s*!important/i,'');
        if(!value)continue;
        for(const selector of rule[1].split(',')){
            const simple=selector.trim();
            if(!/^[#.\w-]+$/u.test(simple))continue;
            const ids=[...simple.matchAll(/#([\w-]+)/g)].map(match=>match[1]);
            const names=[...simple.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);
            if(ids.some(value=>value!==id)||names.some(value=>!classes.includes(value)))continue;
            if(!ids.length&&!names.length)continue;
            const weight=ids.length*100+names.length*10;
            if(weight>=specificity){display=value;specificity=weight;}
        }
    }
    return display==='none';
}
export function inferCallPhase(raw){
    const text=plainText(raw);
    if(callEnded(text))return 'ended';
    if(/(?:電話|通話)(?:が|は)?(?:つながった|繋がった|接続された)|電話に出た/u.test(text))return 'connected';
    if(/(?:통화|전화)(?:가|는)?\s*(?:연결됐|연결되었|이어졌)|(?:전화|통화)(?:를|을)?\s*받았|\bcall (?:is |has )?connected\b/iu.test(text))return 'connected';
    const documents=[...String(raw??'').matchAll(/```html\b([\s\S]*?)```/gi)].map(match=>match[1])
        .filter(html=>/<html\b/i.test(html)&&/\bphone-frame\b/i.test(html));
    for(const html of documents.reverse()){
        const css=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match=>match[1]).join('\n');
        const markup=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
        const views=[];
        for(const opening of markup.matchAll(/<[a-z][\w:-]*\b[^>]*>/gi)){
            const id=opening[0].match(/\bid\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
            if(VIEW_PHASES[id]&&!viewHidden(opening[0],id,css))views.push(VIEW_PHASES[id]);
        }
        // An unstyled document declaring all views is ambiguous; prefer its initial view.
        if(views.length)return views[0];
    }
    return detectPhoneScreen(raw).phase;
}
export function validCallChoiceRecord(message,index,record){
    return Boolean(message&&messageRole(message)==='character'&&record&&record.bodyHash===hash(String(message.mes??''))
        &&record.sourceKey===messageKey(message,index)&&Array.isArray(record.options)&&record.options.length===4
        &&record.options[3]===CALL_END_LABEL&&record.options.every(option=>typeof option==='string'&&option.trim()&&option.length<=240)
        &&new Set(record.options).size===4);
}
export function resolveCallState(chat,throughIndex=(chat?.length??0)-1){
    const state={active:false,phase:'idle',direction:null,originIndex:null,sourceKey:null};
    for(let index=0;index<=throughIndex&&index<(chat?.length??0);index++){
        const message=chat[index],role=messageRole(message);
        if(role==='system')continue;
        const raw=String(message?.mes??''),text=plainText(raw);
        if(role==='user'&&/📞\s*\[발신\s*통화\s*:[^\]\n]*에게\s*전화를\s*건다\s*\]/u.test(text)){
            Object.assign(state,{phase:'dialing',direction:'outgoing',originIndex:index,sourceKey:messageKey(message,index)});continue;
        }
        if(role==='user'&&state.phase==='incoming'&&/(?:電話に出る|通話を受ける|電話を取る)|\[통화\s*(?:수락|선택)\]|(?:전화|통화)(?:를|을)?\s*(?:받는다|수락한다|받을게)/u.test(text))state.phase='connected';
        const phase=inferCallPhase(raw);
        if(phase==='ended'&&state.phase!=='idle')state.phase='ended';
        else if(role==='character'&&phase&&phase!=='ended'){
            if(state.phase==='idle'||state.phase==='ended'){
                state.originIndex=index;state.sourceKey=messageKey(message,index);
                state.direction=phase==='incoming'?'incoming':'outgoing';
            }
            state.phase=phase;
        }
        const record=message.extra?.me35CallChoices;
        if(role==='character'&&state.phase!=='idle'&&state.phase!=='ended'
            &&(splitCallChoices(raw).hadBlock||(validCallChoiceRecord(message,index,record)&&record.sessionKey===state.sourceKey&&record.phase==='connected')))state.phase='connected';
    }
    state.active=state.phase==='dialing'||state.phase==='connected';
    return state;
}
export function callChoicesFor(raw,name,state={},language='ko'){
    const label=String(name??'').replace(/[<>\[\]\r\n]/g,'').trim().slice(0,40)||'너';
    const text=plainText(raw);
    const opening=state.phase==='dialing'||state.phase==='incoming'||/もしもし|聞こえる|電話した/u.test(text)||/여보세요|잘\s*들려|전화(?:했|한)|왜\s*(?:전화|불렀)|무슨\s*일/u.test(text);
    const fallback=language==='ko'
        ?opening?[`${label}, 내 목소리 잘 들려?`,'지금 잠깐 통화 괜찮아?',state.direction==='incoming'?'전화해 줘서 반가워.':'목소리 듣고 싶어서 전화했어.']
            :[`${label}, 듣고 있어. 계속 말해줘.`,'지금 네 쪽은 어때?','그 얘기 조금 더 자세히 들려줄래?']
        :localizedChoiceDefaults('call',language,opening);
    const choices=cleanOptions(splitCallChoices(raw).choices,language);
    for(const option of fallback)if(choices.length<3&&!choices.includes(option))choices.push(option);
    return [...choices,CALL_END_LABEL];
}
export function callChoicesInstruction(state){
    const phase=state?.phase??'idle';
    return `Call state: currentCallPhase=${phase}. A full phone-screen HTML document is a one-time opening, not the format for ongoing call replies. If phase=dialing because the user just explicitly started an outgoing call, follow the phone prompt to show that call's initial screen once; do not invent that the user answered. If an incoming screen is already in the chat or phase=connected, do not repeat or regenerate any phone screen, HTML, CSS, JavaScript, or code fence. After connection, continue only as plain-text spoken dialogue until the call ends. Generate another screen only if the user explicitly starts a new call or requests a new phone screen. The extension displays its own response options outside the character message. Never add choices, choice control tags, choice JSON, or extra choice buttons to the character reply or its phone document. Do not invent that an unchosen option was spoken. [통화 선택] selects the following line as user speech during the call; if the call is incoming, this explicitly accepts it before speaking. The visible user message [통화 종료] means the user ended the call; do not say or imply that the character hung up. Do not start another call or a new narrative mode in response to a hang-up. Directly typed user speech is equally valid.`;
}
