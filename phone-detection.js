// Read phone HTML as data. Never execute its script or rewrite its document.
const VOID_TAGS=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
function attribute(tag,name){return tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i'))?.slice(1).find(value=>value!==undefined)??'';}
function normalized(value){return String(value).replace(/([a-z])([A-Z])/g,'$1-$2').replace(/_/g,'-').toLowerCase();}
function text(value){return String(value).replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot);/gi,' ').replace(/\s+/g,' ').trim();}
export function phoneDocuments(raw){
    const source=String(raw??''),documents=[];
    for(const match of source.matchAll(/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})(?:html|xhtml)?[ \t]*\n([\s\S]*?)(?:\n[ \t]{0,3}\1[ \t]*(?=\n|$)|$)/gi)){
        if(/<html\b/i.test(match[2])||/\b(?:phone-frame|phone-screen|smartphone|iphone)\b/i.test(match[2]))documents.push(match[2]);
    }
    if(!documents.length){
        const unfenced=source.replace(/```[\s\S]*?```/g,'');
        const document=unfenced.match(/(?:<!DOCTYPE\s+html\s*>\s*)?<html\b[\s\S]*?<\/html\s*>/i)?.[0];
        if(document)documents.push(document);
    }
    return documents;
}
function hidden(tag,css){
    if(/\s(?:hidden(?:\s|=|>)|aria-hidden\s*=\s*["']true["'])/i.test(tag))return true;
    const inline=attribute(tag,'style');
    if(/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(inline))return true;
    if(/display\s*:\s*(?:flex|block|grid|inline)/i.test(inline))return false;
    const id=attribute(tag,'id'),classes=attribute(tag,'class').split(/\s+/u);
    if(classes.includes('hidden')||classes.includes('inactive'))return true;
    let value=null,weight=-1;
    for(const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
        const display=rule[2].match(/(?:^|;)\s*display\s*:\s*([^;}]+)/i)?.[1]?.trim().replace(/\s*!important/i,'');
        if(!display)continue;
        for(const candidate of rule[1].split(',')){
            const selector=candidate.trim();if(!/^[#.\w-]+$/u.test(selector))continue;
            const ids=[...selector.matchAll(/#([\w-]+)/g)].map(match=>match[1]);
            const names=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);
            if(ids.some(value=>value!==id)||names.some(value=>!classes.includes(value))||(!ids.length&&!names.length))continue;
            const specificity=ids.length*100+names.length*10;
            if(specificity>=weight){value=display;weight=specificity;}
        }
    }
    return value==='none';
}
function visibleParts(html){
    const css=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match=>match[1]).join('\n');
    const markup=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
    const stack=[],attributes=[],status=[],words=[],controls=[];
    for(const token of markup.matchAll(/<[^>]*>|[^<]+/g)){
        const value=token[0];
        if(value.startsWith('</')){
            const closing=value.match(/^<\/\s*([\w:-]+)/u)?.[1]?.toLowerCase();
            const index=stack.findLastIndex(node=>node.tag===closing);if(index>=0)stack.length=index;
        }else if(value.startsWith('<')){
            const tag=value.match(/^<\s*([a-z][\w:-]*)/iu)?.[1]?.toLowerCase();if(!tag)continue;
            const suppressed=stack.at(-1)?.hidden||tag==='head'||hidden(value,css);
            const isControl=['button','a','input'].includes(tag)||attribute(value,'role')==='button'||/\b(?:button|btn)\b/iu.test(attribute(value,'class'));
            const control=Boolean(stack.at(-1)?.control||isControl);
            if(!suppressed){
                attributes.push({tag,value:normalized([attribute(value,'id'),attribute(value,'class'),attribute(value,'data-state')].join(' ')),control});
                if(isControl)controls.push(attribute(value,'aria-label')+' '+attribute(value,'title'));
            }
            if(!VOID_TAGS.has(tag)&&!/\/\s*>$/u.test(value))stack.push({tag,hidden:suppressed,control});
        }else if(!stack.at(-1)?.hidden){
            words.push(value);if(stack.at(-1)?.control)controls.push(value);else status.push(value);
        }
    }
    return {markup,attributes,status:text(status.join(' ')),words:text(words.join(' ')),controls:text(controls.join(' '))};
}
function structuralPhase(attributes){
    for(const node of attributes){
        if(node.control)continue;
        const value=node.value;
        if(/\b(?:incoming[- ]?(?:call|phone)|(?:call|phone)[- ]?incoming)(?:[- ]?(?:view|screen|container))?\b/u.test(value))return 'incoming';
        if(/\b(?:outgoing[- ]?(?:call|phone)|(?:call|phone)[- ]?outgoing)(?:[- ]?(?:view|screen|container))?\b/u.test(value))return 'dialing';
        if(/\b(?:in-call|(?:connected|active|ongoing)[- ]call|call[- ](?:connected|active|ongoing))(?:[- ]?(?:view|screen|container))?\b/u.test(value))return 'connected';
        if(/\b(?:call[- ](?:ended|terminated|finished)|(?:declined|unanswered|missed)[- ]?(?:call[- ]?)?(?:view|screen))\b/u.test(value))return 'ended';
    }
    return null;
}
function semanticPhase(parts){
    const {status,controls}=parts;
    const direct=structuralPhase(parts.attributes);if(direct)return direct;
    if(/通話終了|不在着信|応答なし|통화\s*종료|전화\s*종료|통화(?:가|는)?\s*(?:끝났|종료됐|끊겼)|부재중\s*(?:전화|통화)?|전화\s*거절|call\s*ended|missed\s*call|no\s*answer/iu.test(status))return 'ended';
    if(/着信中|着信|수신\s*(?:전화|통화)|(?:전화|통화)\s*수신|(?:전화|통화)(?:가|는)?\s*걸려|(?:에게서|로부터)\s*(?:걸려온\s*)?전화|incoming\s*(?:call|video|phone)|is\s*calling/iu.test(status))return 'incoming';
    if(/通話中|接続済み|통화\s*중|(?:전화|통화)\s*(?:연결됨|연결되었|연결됐)|\bin[ -]*call\b|\bcall\s*(?:connected|in progress)\b/iu.test(status))return 'connected';
    if(/発信中|呼び出し中|接続中|발신\s*(?:중|전화|통화)|(?:전화|통화)\s*(?:거는|연결)\s*중|\b(?:calling|dialing|dialling|ringing)\b/iu.test(status))return 'dialing';
    const accept=/応答|受ける|받기|응답|수락|\b(?:answer|accept)\b/iu.test(controls),decline=/拒否|거절|\bdecline\b/iu.test(controls);
    if(accept&&decline&&/電話|通話|전화|통화|facetime|\bcall\b/iu.test(parts.words))return 'incoming';
    if(/切る|終了|끊기|통화\s*종료|전화\s*종료|end\s*call|hang\s*up/iu.test(controls)
        &&/\b(?:call[- ]?(?:timer|duration)|timer|duration)\b/u.test(parts.attributes.map(node=>node.value).join(' '))
        &&/\b\d{1,2}:\d{2}(?::\d{2})?\b/u.test(status))return 'connected';
    return null;
}
export function detectPhoneScreen(raw,{callExpected=false}={}){
    const documents=phoneDocuments(raw);
    const context=text(String(raw??'').replace(/```[\s\S]*?```/g,'').replace(/<html\b[\s\S]*?<\/html\s*>/gi,'')
        .replace(/<messenger_thinking\b[^>]*>[\s\S]*?<\/messenger_thinking\s*>/gi,''));
    for(const html of documents.reverse()){
        const parts=visibleParts(html);let phase=semanticPhase(parts);
        const visibleAttributes=parts.attributes.map(node=>node.value).join(' ');
        const phoneShape=/\b(?:phone-frame|phone-screen|smartphone|iphone|mobile-screen|call-screen|call-container)\b/u.test(normalized(parts.markup));
        const callMarkup=/\b(?:incoming-call|outgoing-call|in-call|call-ended|facetime|call-controls|call-actions)\b/u.test(visibleAttributes);
        const callSemantics=/전화\s*수신|수신\s*전화|통화\s*중|영상\s*통화|facetime|incoming\s*call|outgoing\s*call/iu.test(parts.status)
            ||(/(?:전화|통화|\bcall\b)/iu.test(parts.words)&&/받기|응답|끊기|\b(?:answer|end call|hang up)\b/iu.test(parts.controls));
        if(phase||callMarkup||callSemantics)return {type:'call',phase,direction:phase==='incoming'?'incoming':phase==='dialing'?'outgoing':null};
        const knownApp=/플레이리스트|재생\s*중|가사|앨범|스케줄|달력|일정|배송|주문|지도|길찾기|예약|메모|\b(?:playlist|now playing|calendar|schedule|delivery|order|map|navigation|reservation|notes)\b/iu.test(parts.words+' '+visibleAttributes);
        if(/송금|이체|transfer|bank\s*account|계좌\s*번호|₩\s*[\d,]+/iu.test(parts.words))return {type:'transfer',phase:null,direction:null};
        if(/선물|\bgift\b/iu.test(parts.words))return {type:'gift',phase:null,direction:null};
        const answering=/받기|응답|수락|\b(?:answer|accept)\b/iu.test(parts.controls)&&/거절|\bdecline\b/iu.test(parts.controls);
        if(phoneShape&&answering&&!knownApp)phase='incoming';
        else if(phoneShape&&/call\s+from|starts\s+facetime|전화(?:가|는)?\s*걸려|수신\s*전화|(?:에게서|로부터).{0,40}전화/iu.test(context))phase='incoming';
        else if(phoneShape&&/(?:에게\s*거는|전화\s*거는)\s*중|\bcalling\b/iu.test(context))phase='dialing';
        if(phase)return {type:'call',phase,direction:phase==='incoming'?'incoming':'outgoing'};
        if(callExpected&&!knownApp)return {type:'call',phase:null,direction:null};
        if(phoneShape)return {type:'screenshot',phase:null,direction:null};
    }
    return {type:null,phase:null,direction:null};
}
export function inferPhoneTypeRobust(raw,options){return detectPhoneScreen(raw,options).type;}
