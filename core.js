import {normalizeTimestampMarkup} from './message-presentation.js?v=3.5.63';
// State, output normalization and detection helpers.
import {inferPhoneTypeRobust} from './phone-detection.js';
export const KEY = 'messenger35';
export function hash(s) {
    let a=2166136261,b=5381;
    for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b,33)^s.charCodeAt(i);}
    return `${(a>>>0).toString(36)}${(b>>>0).toString(36)}`;
}
export function messageKey(m,i){return `${i}:${m.swipe_id??0}:${hash(String(m.mes??''))}`;}
export function freshMeta(){return {version:2,actions:[],seen:{},modes:{},declined:{}};}
export function koreanClock(date=new Date()){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
        timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
    }).formatToParts(date).map(part=>[part.type,part.value]));
    return `${parts.month}.${parts.day}, ${parts.hour}:${parts.minute}`;
}
export function validScenarioTime(value){return typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);}
export function koreanTopicParticle(name){
    const last=String(name??'').normalize('NFC').replace(/[\s\p{P}\p{S}]+$/gu,'').at(-1);
    if(!last)return null;
    const code=last.codePointAt(0);
    if(code>=0xac00&&code<=0xd7a3)return (code-0xac00)%28===0?'는':'은';
    if(/[ㄱ-ㅎ]/u.test(last)||(code>=0x11a8&&code<=0x11ff))return '은';
    if(/[ㅏ-ㅣ]/u.test(last)||(code>=0x1161&&code<=0x11a7))return '는';
    if(/\d/.test(last))return /[013678]/.test(last)?'은':'는';
    return null;
}
export function koreanSilenceLabel(name,particle='는'){
    const label=String(name??'캐릭터').normalize('NFC').replace(/\s+/g,' ').trim().replace(/[\s.!?…。！？]+$/gu,'')||'캐릭터';
    return `${label}${koreanTopicParticle(label)??(particle==='은'?'은':'는')} 답장하지 않았다.`;
}
export const NARRATIVE_CONTINUE_LABEL='응답 없이 서사 계속';
const fallbackChoices=['한 걸음 다가가 무슨 일인지 묻는다.','잠시 주변을 살핀 뒤 내가 할 일을 정한다.','지금 느낀 점을 솔직하게 전한다.'];
export function splitNarrativeChoices(raw){
    let payload='',hadBlock=false;
    let body=String(raw??'').replace(/<me35_choices\b[^>]*>([\s\S]*?)<\/me35_choices\s*>/gi,(_,value)=>{
        payload=value.trim();hadBlock=true;return '';
    });
    // A truncated control block must not consume prose on the following line.
    body=body.replace(/<me35_choices\b[^>]*>([\s\S]*)/gi,(_,value)=>{
        hadBlock=true;
        const start=value.search(/\S/),content=value.slice(Math.max(0,start));
        let end=-1,depth=0,quoted=false,escaped=false;
        if(/^[\[{]/u.test(content))for(let i=0;i<content.length;i++){
            const ch=content[i];
            if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
            if(ch==='"'){quoted=true;continue;}
            if(ch==='['||ch==='{')depth++;
            if(ch===']'||ch==='}')if(--depth===0){end=i+1;break;}
        }
        if(end<0){
            let offset=0;
            for(const line of content.split(/(?<=\n)/u)){
                if(offset>0&&line.trim()&&!/^\s*(?:[\[{"}\],]|```)/u.test(line)){end=offset;break;}
                offset+=line.length;
            }
            if(end<0)end=content.length;
        }
        payload=content.slice(0,end).trim();
        return content.slice(end).replace(/^\s*```\s*(?:\n|$)/u,'\n');
    }).replace(/```(?:json)?\s*```/gi,'').trimEnd();
    let choices=[];
    if(payload){
        try{
            const parsed=JSON.parse(payload.replace(/^```(?:json)?\s*|\s*```$/gi,''));
            const values=Array.isArray(parsed)?parsed:parsed?.choices;
            if(Array.isArray(values))choices=values.filter(value=>typeof value==='string');
        }catch{/* A malformed control block must never prevent the scene from rendering. */}
    }
    choices=choices.map(value=>value.replace(/<[^>]*>/g,'').replace(/^\s*(?:\d+[.)]|[①②③④])\s*/u,'').replace(/\s+/g,' ').trim().slice(0,240))
        .filter(value=>value&&!/^\[?서사\s*계속\]?|^응답 없이 서사 계속/u.test(value));
    const directions=[...new Set(choices)].slice(0,3);
    for(const fallback of fallbackChoices)if(directions.length<3&&!directions.includes(fallback))directions.push(fallback);
    return {body,hadBlock,choices:[...directions,NARRATIVE_CONTINUE_LABEL]};
}
export function normalizeKoreanSilence(raw,name){
    const text=visibleText(raw).trim();
    const marker=koreanSilenceMarker(text,name);
    if(!marker)return String(raw??'');
    const particle=marker.particle??'는';
    return String(raw??'').replace(text,()=>koreanSilenceLabel(name,particle));
}
function koreanSilenceMarker(text,name){
    const value=String(text).normalize('NFC').trim().replace(/^[\s(（\[*]+|[\s)）\]*]+$/gu,'');
    const match=value.match(/^(?:(.{1,80}?)(은|는)\s*)?답장(?:을)?\s*하지\s*않았다[.。…]?$/u);
    if(!match)return null;
    if(match[1]){
        const candidate=match[1].trim();
        const known=String(name??'').normalize('NFC').trim().replace(/[\s.!?…。！？]+$/gu,'');
        if(candidate!==known&&(candidate.split(/\s+/u).length>2||/^(?:결국|그래서|그러나|하지만|아직|끝내|그때|잠시|한참)\s/u.test(candidate)))return null;
    }
    return {particle:match[2]};
}
export function derive(meta,chat){
    const valid=new Set(chat.map(messageKey));
    const state={mode:'messenger',drinking:'sober'};
    for(const action of meta.actions??[]){
        if(action.source&&!valid.has(action.source))continue;
        if(action.mode)state.mode=action.mode;
        if(action.drinking)state.drinking=action.drinking;
    }
    if(meta.narrativeEnabled===false)state.mode='messenger';
    return state;
}
export function canSuggest(meta,chat,index){
    if(meta.narrativeEnabled===false||derive(meta,chat).mode!=='messenger')return false;
    return !Object.entries(meta.declined??{}).some(([key,i])=>chat[i]&&messageKey(chat[i],i)===key&&index-i<8);
}
export function messageRole(message){
    if(!message||message.is_system===true)return 'system';
    // SillyTavern stores is_user explicitly. A stale or auxiliary role field
    // must not turn a character reply into a new user message.
    if(typeof message.is_user==='boolean')return message.is_user?'user':'character';
    if(message.role==='system')return 'system';
    return message.role==='user'?'user':'character';
}
export function hasUserContent(message){
    const extra=message?.extra??{};
    return Boolean(String(message?.mes??'').trim()||extra.image||extra.audio||extra.video||extra.file||extra.attachments?.length);
}
export function pendingUserInput(chat){
    for(let i=(chat?.length??0)-1;i>=0;i--){
        const message=chat[i],role=messageRole(message);
        if(role==='system')continue;
        if(role!=='user')return false;
        return hasUserContent(message);
    }
    return false;
}
export function latestMessageRole(chat){
    for(let i=(chat?.length??0)-1;i>=0;i--){
        const role=messageRole(chat[i]);
        if(role!=='system')return role;
    }
    return 'none';
}
export function unansweredCount(chat){
    let count=0;
    for(let i=(chat?.length??0)-1;i>=0;i--){
        const role=messageRole(chat[i]);
        if(role==='system')continue;
        if(role==='user'){
            if(hasUserContent(chat[i]))return count;
            continue;
        }
        if(!isSilentCharacterBeat(chat[i].mes,chat[i].name))count++;
    }
    // Opening character messages without a preceding user turn are not unanswered.
    return 0;
}
export function unansweredCallMade(chat){
    for(let i=(chat?.length??0)-1;i>=0;i--){
        const message=chat[i];
        const role=messageRole(message);
        if(role==='system')continue;
        if(role==='user'){
            if(hasUserContent(message))return false;
            continue;
        }
        if(inferPhoneType(message.mes)==='call')return true;
    }
    return false;
}
export function containsThought(raw){
    return /<\s*messenger_thinking\s*>[\s\S]*?<\s*\/\s*messenger_thinking\s*>/i.test(String(raw??''));
}
export function normalizeThoughtSpacing(raw){
    const source=String(raw??'');
    const separate=text=>normalizeTimestampMarkup(text)
        .replace(/[ \t\r\n]*(<\s*messenger_thinking\b[^>]*>[\s\S]*?<\s*\/\s*messenger_thinking\s*>)([ \t\r\n]*)/gi,
            (match,block,tail,offset,whole)=>(offset>0?'\n\n':'')+block.replace(/\r?\n[ \t]*/g,' ')+(offset+match.length<whole.length?'\n\n':tail))
        .replace(/(<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\b(?:chat-timestamp|custom-chat-timestamp|msg-time|custom-msg-time|chat-time|custom-chat-time)\b)[^>]*>[\s\S]*?<\/div>)(?:[ \t\r\n]|<br\s*\/?\s*>)*(?=\S)/gi,'$1\n\n');
    // Never alter phone-screen documents, code fences, or embedded script/style.
    const protectedBlocks=/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\1[ \t]*(?=\n|$)|$)|<html\b[^>]*>[\s\S]*?(?:<\/html\s*>|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\2\s*>|$)/gi;
    let result='',start=0;
    for(const match of source.matchAll(protectedBlocks)){
        result+=separate(source.slice(start,match.index))+match[0];start=match.index+match[0].length;
    }
    return result+separate(source.slice(start));
}
export function shouldNotifyThought(mode,raw){return mode==='moments'&&containsThought(raw);}
export function inferPhoneType(raw,options){return inferPhoneTypeRobust(raw,options);}
function visibleText(raw){
    return splitNarrativeChoices(raw).body
        .replace(/```[\s\S]*?```/g,' ')
        .replace(/<\s*messenger_thinking\s*>[\s\S]*?<\s*\/\s*messenger_thinking\s*>/gi,' ')
        .replace(/<div\b[^>]*\b(?:chat-timestamp|custom-chat-timestamp|msg-time|custom-msg-time|chat-time|custom-chat-time)\b[^>]*>[\s\S]*?<\/div>/gi,' ')
        .replace(/<[^>]*>/g,' ').slice(0,5000).trim();
}
export function isSilentCharacterBeat(raw,name){
    if(inferPhoneType(raw))return false;
    const visible=visibleText(raw),text=visible.replace(/[\s().。…（）\[\]*]/g,'');
    const marker=visible.split(/\r?\n/,1)[0].trim();
    const status=marker.replace(/^[\s*（(\[]+|[\s*）)\]]+$/gu,'').trim();
    const localizedMarker=Boolean(koreanSilenceMarker(marker,name))
        ||/^(?:.+は)?(?:既読スルーした|既読無視した|(?:返事|返信)を?しなかった)[。.!]?$/u.test(status)
        ||/^.+ did not reply(?: to .+['’]s message)?[.!]?$/iu.test(status);
    return !text||localizedMarker||Boolean(koreanSilenceMarker(visible,name))||/^(?:답장하지않음|(?:.*は)?(?:返事|返信)を?しなかった|既読無視|readbutdidnotreply|leftonread|.+didnotreply)$/iu.test(text);
}
function textingEndpoint(raw){
    return /(?:また(?:後で|あとで|明日)(?:話そう|連絡する)|スマホを(?:置く|しまう)(?:ね|よ|。))/u.test(visibleText(raw))||/(?:나중에|이따|내일)\s*(?:다시\s*)?(?:얘기하자|톡할게|연락할게)|(?:오늘은|얘기는)\s*여기까지|(?:폰|휴대폰)(?:을)?\s*(?:내려놓|넣어둘)|そろそろ(?:出る|行く|支度)|また(?:あとで|後で|明日)|続きは(?:あとで|後で|明日)|\b(?:talk to you later|talk (?:again )?tomorrow|putting (?:my|the) phone (?:away|down)|time for me to head out)\b/i.test(visibleText(raw));
}
export function inferDrinkingStart(raw){
    const text=visibleText(raw);
    // Detect actual consumption clause by clause: a wish in one sentence must
    // not suppress an actual sip later, and distress alone is not consumption.
    const clauses=text.match(/[^\n.!?。！？]+[.!?。！？]?/gu)??[];
    return clauses.some(clause=>{
        if(/[?？]\s*$/u.test(clause))return false;
        if(/(?:어제|지난주|작년에|예전에).{0,24}(?:마셨|들이켰|비웠)|\b(?:yesterday|last (?:night|week)|used to)\b.{0,24}\b(?:drank|had|drink)\b|(?:昨日|先週|昔は).{0,24}飲んだ/iu.test(clause))return false;
        if(/(?:네가|니가|당신이|너는|너도|유저가|친구가|친구는)\s*(?:지금\s*)?(?:술|맥주|소주|와인|위스키|하이볼)|\byou (?:are |were )?(?:drinking|drank|had a)\b/iu.test(clause))return false;
        if(/(?:마시(?:지|지는|지도)\s*(?:않|못)|안\s*마셨|마신\s*(?:적|척)|마셨(?:다면|으면|을|다고)|마신다면|마시고\s*있(?:지|는\s*척)|들이키(?:지|지는)\s*(?:않|못)|飲(?:んで(?:は)?いない|んでない|まない|んだ(?:ら|と)|むふり)|\b(?:not drinking|never drank|did(?:n't| not) drink|if i (?:drank|drink))\b)/iu.test(clause))return false;
        const korean=/(?:술|맥주|소주|와인|위스키|칵테일|막걸리|하이볼|보드카|브랜디|사케|샴페인)(?:을|를|도)?\s*(?:(?:한|두|세|몇|첫|작은|큰|\d+)\s*(?:잔|캔|병|모금)(?:을|를|씩|째)?\s*)?(?:마시는\s*중|마시고\s*있|마셨(?!으면|다면|을)|마신다(?!면)|마셔\s*(?:버렸|버린)|마시기\s*시작|한\s*잔\s*했|들이켰|들이킨다|들이키고\s*있|들이켜\s*마셨|홀짝였|홀짝인다|홀짝이고\s*있|털어\s*넣었|넘겼)/u;
        const glass=/(?:술잔|맥주\s*캔|와인\s*잔|소주\s*잔|위스키\s*잔|하이볼\s*잔).{0,28}(?:비웠|기울였|마셨|입술에\s*댔|한\s*모금|홀짝였|들이켰)/u;
        const japanese=/(?:酒|ビール|ワイン|ウイスキー|焼酎|ハイボール|日本酒)(?:を|も)?(?:今)?(?:一口|一杯)?飲(?:んでいる|んでる|み始めた|んだ)(?!ら)|(?:グラス|缶).{0,16}(?:傾けた|飲み干した)/u;
        const english=/\bi(?:'m| am) (?:already )?drinking\b(?!\s+(?:water|coffee|tea|juice|milk|soda)\b)|\bi (?:just |have |have just )?(?:had|drank|sipped|downed|started drinking) (?:a |some |my |the |a glass of |a sip of |a can of )?(?:beer|wine|whisk(?:e)?y|vodka|sake|champagne|alcohol|cocktail|drink)\b/iu;
        if(korean.test(clause)||glass.test(clause)||japanese.test(clause)||english.test(clause))return true;
        // A generic first sip needs explicit alcohol context; water/coffee do not count.
        return /(?:술|맥주|소주|와인|위스키|칵테일|막걸리|하이볼|보드카|사케|샴페인)/u.test(text)
            &&!/(?:물|커피|차|주스|우유)(?:을|를|의)?\s*(?:첫|한)?\s*모금/u.test(clause)
            &&/(?:첫|한)\s*모금\s*(?:마셨|넘겼|삼켰)/u.test(clause);
    });
}
export function inferDrinkingEnd(raw){
    const text=visibleText(raw);
    if(/酔いが(?:すっかり|完全に)?(?:覚めた|醒めた)|(?:今は|もう)しらふ|(?:今日は|もう)お酒を飲むのをやめた/u.test(text))return true;
    return /(?:술|취기)(?:이|가)?\s*(?:다\s*)?(?:깼어|깼다|가셨어|가셨다)|(?:이제|오늘은)\s*술\s*안\s*마셔|\b(?:i(?:'m| am) sober now|i stopped drinking)\b/i.test(text);
}
export function inferNarrativeCue(raw){
    const text=visibleText(raw);
    if(!text)return false;
    const cues=[
        /(?:今から|今すぐ)(?:そっちに|会いに)?行く[。！!]|(?:もう|今)(?:玄関|ドア|家)の前に(?:いる|着いた)|(?:今日|明日|今から)(?:は|、)?会おう|直接(?:会って|顔を見て)話そう|本当のことを(?:話す|伝える)(?:よ|ね|。)|(?:呼び鈴|インターホン|電話のベル)が鳴った/u,

        // An actual invitation, departure, or arrival opens a scene.
        /(?:지금\s*(?:갈게|가고\s*있어|출발할게)|(?:문\s*앞|현관\s*앞|약속\s*장소|집\s*앞)에\s*(?:있어|왔어|도착)|(?:우리|오늘|지금|내일)\s*만나자|(?:오늘|내일|이번\s*주).{0,16}(?:만날까|볼\s*수\s*있|만날\s*수\s*있)|(?:곧|방금)\s*도착했|(?:만날|볼)\s*(?:시간|장소)(?:을|를)?\s*(?:정하|잡)|(?:코트|외투|신발|열쇠|차\s*키).{0,24}(?:챙기|집어|신고|들고).{0,32}(?:나서|나갔|문을\s*열|밖으로)|(?:현관문|방문|차문|문)을\s*(?:열었|열고\s*나))/i,
        // A conversation has reached a concrete choice, disclosure, or interruption.
        /(?:(?:문자|메신저|채팅|톡)(?:로|로는|만으론).{0,32}(?:안\s*되|못\s*하|부족|직접)|직접\s*(?:만나서|보고|얘기하자|말하자)|(?:이대로|이렇게)\s*(?:끝낼|넘길|두|계속할)\s*수\s*없|(?:더는|이제)\s*(?:숨길|피할)\s*수\s*없|(?:사실|진실|비밀).{0,28}(?:말해야|밝혀야|알아야|말할게)|(?:지금|당장)\s*(?:결정해야|선택해야)|(?:초인종|문\s*두드리는\s*소리|전화벨)(?:이|가)?\s*(?:울렸|울려|들렸))/i,
        /(?:복도|현관|창밖|골목).{0,20}(?:낯선\s*발소리|낯선\s*목소리|기척)|(?:전등|불)(?:이|가)?\s*(?:갑자기\s*)?(?:꺼졌|깜박였)/i,
        /\b(?:i(?:'m| am) (?:on my way|at your door)|let's meet (?:now|today|tomorrow)|let's talk (?:in person|face to face)|text(?:ing)? (?:isn't|is not) enough|i (?:can't|cannot) keep (?:hiding|avoiding) this|i need to tell you the truth)\b/i,
    ];
    return cues.some(pattern=>pattern.test(text));
}
const OPPORTUNITY_PATTERNS={
    invitation:/(?:오늘|내일|이번\s*주|지금).{0,18}(?:만나자|만날까|만날|볼\s*수\s*있|시간\s*돼|어디서\s*볼)|(?:너|우리).{0,12}(?:직접\s*보|만나자|만날까|만나고\s*싶)/i,
    choice:/(?:결정했|선택했|마음(?:을)?\s*정했|그만두기로\s*했|떠나기로\s*했|돌아가기로\s*했|말하기로\s*했|더는\s*피하지\s*않|can't\s*keep\s*avoiding)/i,
    revelation:/(?:사실|그날|비밀|숨겨|말하지\s*못했|말\s*못\s*했).{0,38}(?:말할게|알아야|말해야|밝힐|이야기할게|드러났)|(?:말할게|말해야|밝힐).{0,38}(?:사실|그날|비밀|숨겨)/i,
    consequence:/(?:우리\s*(?:사이|관계)|너와\s*나|함께한\s*시간).{0,28}(?:달라졌|달라진|예전\s*같지\s*않|변했|끝낼|시작|다시|돌이킬|잃)|(?:이대로|이렇게).{0,12}(?:끝낼|넘길|계속할)\s*수\s*없/i,
    interruption:/(?:초인종|전화벨|경보|문\s*두드리는\s*소리)(?:이|가)?\s*(?:울렸|울려|들렸)|(?:누군가|낯선\s*사람).{0,20}(?:문\s*앞|찾아왔|나타났)|(?:복도|현관|창밖|골목).{0,20}(?:발소리|기척|낯선\s*목소리)|(?:전등|불|화면)(?:이|가)?\s*(?:꺼졌|깜박였)|(?:막차|버스|택시)(?:가|이)?\s*(?:도착했|멈췄)/i,
    action:/(?:택시를\s*불렀|표를\s*끊었|예약했|짐을\s*챙겼|밖으로\s*나섰|문을\s*열고\s*나갔|차\s*키를\s*집었|직접\s*찾아갈|출발했|가는\s*중)/i,
    quietIntimacy:/(?:말없이|한참\s*침묵|잠시\s*침묵|조용히).{0,36}(?:손을\s*뻗|옆에\s*앉|기댔|기대었|문\s*앞|같은\s*공간|눈을\s*맞췄)|(?:손을\s*뻗|옆에\s*앉|기댔|기대었|눈을\s*맞췄).{0,36}(?:말없이|조용히|침묵)/i,
};
function opportunityCategories(raw){
    const text=visibleText(raw);
    return Object.entries(OPPORTUNITY_PATTERNS)
        .filter(([,pattern])=>pattern.test(text))
        .map(([name])=>name);
}
export function narrativeOpportunity(chat,index,options={}){
    const no={offer:false,reason:null,score:0};
    const message=chat?.[index];
    if(!message||messageRole(message)!=='character')return no;
    const raw=String(message.mes??'');
    if(options.phoneThisTurn||inferPhoneType(raw)||isSilentCharacterBeat(raw))return no;
    if(Number.isInteger(options.lastProposalIndex)&&options.lastProposalIndex>=0&&index-options.lastProposalIndex<8)return no;
    if(Number.isInteger(options.lastReturnIndex)&&options.lastReturnIndex>=0&&index-options.lastReturnIndex<5)return no;

    if(textingEndpoint(raw))return {offer:true,reason:'texting_endpoint',score:4};

    // A concrete action can open a scene on its own. Abstract emotion cannot.
    if(inferNarrativeCue(raw))return {offer:true,reason:'concrete_beat',score:4};

    const current=opportunityCategories(raw);
    let lastUserIndex=-1;
    for(let i=index-1;i>=0;i--){
        if(messageRole(chat[i])==='user'&&hasUserContent(chat[i])){lastUserIndex=i;break;}
    }
    const lastUser=lastUserIndex>=0?chat[lastUserIndex]:null;
    const reply=visibleText(raw);
    if(lastUser&&index-lastUserIndex<=2&&OPPORTUNITY_PATTERNS.invitation.test(visibleText(lastUser.mes))
        &&/(?:좋아|그러자|응[,!.\s]|약속|갈게|가자|준비할게|시간\s*정하자|let's\s*do\s*it|sounds\s*good)/i.test(reply)
        &&!/(?:안\s*돼|못\s*(?:가|만나)|싫어|다음에|not\s*(?:today|now)|can't\s*meet)/i.test(reply)){
        return {offer:true,reason:'shared_plan',score:4};
    }
    const prior=(chat??[]).slice(Math.max(0,index-8),index)
        .filter(item=>messageRole(item)==='character'||(messageRole(item)==='user'&&hasUserContent(item)));
    const relevant=prior.filter(item=>opportunityCategories(item.mes).length);
    const unanswered=unansweredCount(chat.slice(0,index+1));
    const score=current.length*2+Math.min(relevant.length,2)+(unanswered>=4?1:0);
    if(current.length>=2&&prior.length>=2&&!current.every(category=>category==='quietIntimacy'))
        return {offer:true,reason:'developing_beat',score};
    if(relevant.length>=1&&prior.length>=3)return {offer:true,reason:'developing_beat',score};
    if(unanswered>=4&&current.some(category=>['choice','revelation','interruption','action'].includes(category)))
        return {offer:true,reason:'silence_to_action',score};
    // Two outgoing character replies without a new user reply form a pacing beat, even if the model
    // keeps producing angry texts. Offer only once per real user-message key.
    if(unanswered>=2&&!options.silenceAlreadyOffered)
        return {offer:true,reason:'sustained_silence',score:Math.max(score,2)};
    return {offer:false,reason:null,score};
}
export function inferMessengerReturn(raw){
    return /(?:^|\n)\s*📩\s*\[[^\]\n]{1,800}\]\s*$/u.test(visibleText(raw));
}
function narrativeChoicesInstruction(meta){
    if(meta.narrativeChoicesEnabled!==true)return '';
    return 'The extension generates narrative choices separately. Write only the completed scene in this reply. Never append a choices list, JSON, me35_choices or me35_call_choices tag to the character response or a phone HTML document. A user message beginning [서사 선택] names an action or line the user chose; it is a selected user action, not literal dialogue. Carry out only that stated user action and its direct consequences. Never decide any additional action, words, thoughts, feelings, consent, or decisions for the user. Write the character and scene reactions normally. Keep all scene paragraphs and timestamp restrictions.';
}
export function refreshRequestState(messages,meta,chat,{type='normal',character='the character',user='the user'}={}){
    // Swipe retains the old answer in UI history while excluding it from the request.
    const history=type==='swipe'&&messageRole(chat.at(-1))==='character'?chat.slice(0,-1):chat;
    const runtime=runtimePrompt(meta,history);
    for(let i=messages.length-1;i>=0;i--){
        const message=messages[i];
        if(message.role!=='system'||typeof message.content!=='string')continue;
        const hadGuard=message.content.includes('[MESSENGER_35_TURN]');
        message.content=message.content.replace(/^\[MESSENGER_35_RUNTIME\][ \t]*\r?\n[\s\S]*?^\[\/MESSENGER_35_RUNTIME\][ \t]*(?=\r?$)/gm,()=>runtime)
            .replace(/^\[MESSENGER_35_TURN\][ \t]*\r?\n[\s\S]*?^\[\/MESSENGER_35_TURN\][ \t]*(?=\r?$)/gm,'');
        if(hadGuard&&!message.content.trim())messages.splice(i,1);
    }
    const pending=pendingUserInput(history);
    const narrative=derive(meta,history).mode==='narrative';
    const output=meta.callEndRequested
        ? meta.callEndRequested
        :meta.callSessionActive
        ? 'A fictional phone call is in progress. Follow the phase-specific call instructions below. Once connected, respond only in plain-text spoken dialogue; do not repeat or generate a full phone-screen HTML/CSS/JavaScript document. A [통화 선택] line is the user\'s chosen spoken response. Directly typed user speech is equally valid. '+(meta.callChoicesGuide??'')
        :narrative
        ? 'NARRATIVE IS ACTIVE. Write the next scene as novel-like prose: 3–5 connected paragraphs of character action, description and consequences, normally at least 6–10 meaningful sentences. After any required thought block, start the scene body with action or perception, without a timestamp or time header. Quote spoken dialogue; use [text] without an emoji or icon prefix only for an actual message inside the scene. A reply consisting only of texts, dialogue, or a thought block is not valid narrative. Preserve the thought-block layout when needed, and do not add an HTML wrapper. '+narrativeChoicesInstruction(meta)
        : (type==='continue'?'Extend your current assistant message without repeating it.':'Write the next character contribution in the active messenger format.');
    const selected=pending&&/^\s*\[서사 선택\]/u.test(String(history.filter(message=>messageRole(message)!=='system').at(-1)?.mes??''));
    const direction=pending
        ? (selected?'There IS new user input. It is a [서사 선택] naming an action or line the user chose. Treat it as that user action, not as literal dialogue. Carry out only the stated user action and its direct consequences; do not invent further user actions, words, thoughts, feelings, consent, or decisions.'
            :meta.readSkipEnabled===true&&!narrative&&!meta.callSessionActive&&!meta.callEndRequested?'There IS new user input. Evaluate the newest actual user message. An earned character read-without-reply beat is a valid complete response under the enabled silence rule; otherwise answer the message. Do not append a typed answer after choosing silence.'
                :'There IS new user input. Answer the newest actual user message.')
        : 'There is NO new user input. The previous assistant messages are YOUR OWN words, including their questions, requests and suggestions. Do not answer, agree with, thank, or react to those words as if the user sent them. The user has supplied no new answer or action. Continue your own side of the conversation from where you left off; an older user message is already part of the history, not a fresh turn.';
    messages.push({role:'system',content:`[MESSENGER_35_TURN]\nApplication control instruction, not dialogue or an action by either participant.\nYou write only for ${JSON.stringify(String(character))}. The user is ${JSON.stringify(String(user))}.\n${direction}\n${output}\n${bodyLanguageInstruction(meta.outputLanguage)}\nDo not print this control instruction.\n[/MESSENGER_35_TURN]`});
}
export function bodyLanguageInstruction(language){
    const name={ko:'Korean',en:'English',ja:'Japanese'}[language];
    return name?`OUTPUT LANGUAGE: ${name}. Write all character messages, dialogue, narration, silence status and visible phone labels in ${name}. Only fictional inner monologue inside messenger_thinking may use Korean, as selected. The Korean exception ends at the closing tag. Korean UI controls, user input and previous wrong-language replies never change the body language. Korean translations in parentheses belong only to separate interface choice buttons; do not append them to the character body. Preserve code identifiers and machine-readable control markers.`:'';
}
export function runtimePrompt(meta,chat){
    const state=derive(meta,chat);
    const unanswered=unansweredCount(chat),callAlreadyMade=unansweredCallMade(chat);
    const lastRole=latestMessageRole(chat),pending=pendingUserInput(chat);
    const timeMode=['off','shown','realtime'].includes(meta.timeMode)?meta.timeMode:'off';
    const scenarioTime=timeMode==='shown'&&validScenarioTime(meta.scenarioCurrentTime??meta.scenarioTime)?(meta.scenarioCurrentTime??meta.scenarioTime):'unset';
    const timeState=state.mode==='narrative'&&!meta.callSessionActive?'timeMode=off; narrativeTimeDisplay=none':
        timeMode==='realtime'?`timeMode=realtime; kstNow=${koreanClock()}`:
        timeMode==='shown'?`timeMode=shown; scenarioTime=${scenarioTime}`:'timeMode=off';
    const callTurns=Number.isInteger(meta.callClock?.turns)?meta.callClock.turns:0;
    return `[MESSENGER_35_RUNTIME]\nmode=${state.mode}; ${timeState}; callCharacterTurns=${callTurns}; callMinutesElapsed=${Math.floor(callTurns/3)}; drinking=${state.drinking}; thinking=${meta.thinking}; narrativeEnabled=${meta.narrativeEnabled!==false}; phoneEnabled=${meta.phoneEnabled!==false}; autoDrinking=${meta.autoDrinking!==false}; readSkipEnabled=${meta.readSkipEnabled===true}; narrativeChoicesEnabled=${meta.narrativeChoicesEnabled===true}; unansweredCount=${unanswered}; callAlreadyMade=${callAlreadyMade}; latestActualMessageRole=${lastRole}; pendingUserMessage=${pending}
${bodyLanguageInstruction(meta.outputLanguage)}
These values reflect the extension's current controls and the selected SillyTavern prompt toggles. Do not print them. Never append hidden HTML comments or extension event markers to a reply.
If pendingUserMessage=false, there is no new user input to answer. The latest message may be the character's own reply or an empty user turn. Any older user message or user text repeated elsewhere in the prompt is history, not a fresh turn to answer. Do not treat the character's own last output as something the user said. Continue naturally from the character's side without inventing a user reply. If pendingUserMessage=true, evaluate the newest actual user message in the chat history and choose a character-consistent response, including the enabled silence exception below.
If mode=messenger, readSkipEnabled=true and there is an actual incoming user message, a read-without-reply beat is a genuine option. Follow the enabled Intentional Silence trigger: character-specific conflict or emotional overwhelm can justify withholding a reply. Use it occasionally when silence fits better than an immediate answer, without a random quota or repeated punishment. Do not ignore routine greetings or straightforward questions by habit, and do not repeat silence for the same unresolved message. Preserve explicit user requests for a call, media or scene progression rather than using silence to block them. For a Korean silence beat, start with the localized status on its own line with the character name and the correct 은/는 particle, for example ${JSON.stringify(koreanSilenceLabel(meta.characterName??'캐릭터'))}; use 은 after a final consonant and 는 after a vowel. For names written in another script, use the pronounced name to choose the particle. Preserve a required messenger timestamp and at most the one enabled thought block, but send no typed reply, filler bubble or phone screen in that turn. After the status, insert one empty line and write the required 400–700 token close third-person character scene under the enabled Intentional Silence prompt: concrete physical actions, sensory emotion and internal conflict. Do not stop after the status. Keep this prose visible outside messenger_thinking; never invent user actions or words. The status plus scene overrides ordinary messenger bubble-length requirements and does not switch the extension into narrative mode. When readSkipEnabled=false, do not invoke this silence feature. Narrative scenes continue under their own rules.
If mode=narrative and no phone call is active, write a developed novel-like scene in prose paragraphs under the narrative prompt, within the existing message container. Start with prose, without any visible timestamp or time header even if a time display prompt is enabled. Do not output only phone messages or a thought block. Preserve the thought layout when needed; the container does not restrict the body to texting. If mode=messenger, keep the messenger format until the user accepts a narrative switch. A narrative proposal is not consent. Let a concrete decision, invitation, departure, arrival, interruption, or relationship-changing disclosure create an opening naturally, so the extension can offer the switch. A natural texting endpoint also qualifies. After two outgoing character replies without a new user reply, the extension can offer a scene without requiring special cue wording. A character-only read-without-reply marker is not an outgoing follow-up and does not count toward that threshold. Narrative mode stays active until the user explicitly switches back with the extension mode control. A phone message inside a scene, including a final standalone [message text] line, never changes the mode. This runtime rule overrides older prompt instructions treating that line as an automatic return signal. Continue the scene in narrative mode on subsequent replies. An earned meeting in narrative mode is allowed when the meeting prompt permits it; do not teleport anyone.
When a visible timestamp is required, use exactly the class chat-timestamp and the inline 12px timestamp template from the selected time prompt. Do not replace it with msg-time or omit the inline style. Finish its closing div, then insert two actual newline characters before any following content. This rule never enables a timestamp in narrative mode or timeMode=off.
For messenger mode and active-call time: timeMode=off means show no clock or timestamp. With timeMode=shown and scenarioTime=HH:mm, this is the selected starting time or the latest timestamp observed in this chat. Continue from it and advance the fictional time consistently with the story, displaying HH:mm only; do not restart at the initial setting each turn. With scenarioTime=unset, choose one plausible random starting time for this chat and keep its progression coherent. With timeMode=realtime, use kstNow (MM.DD, HH:mm) as the current real Korean date and time for this turn; it overrides a conflicting date/time macro or device-local clock. Do not display or inject a clock in narrative replies unless a phone call is active. During an active phone call with timeMode=shown, including a call that begins during narrative mode, the extension advances its clock by one minute after every three character replies; keep the call screen's displayed time aligned with scenarioTime. With timeMode=realtime, keep the call screen's displayed time aligned with kstNow. If a newer displayed timestamp is provided, follow that timestamp as the current time.
unansweredCount is the number of consecutive character messages after the latest actual user message. It is not proof that the user read or deliberately ignored anything. Never invent a user reply, read receipt, action, or consent. In messenger mode only, after multiple unanswered character messages, change approach rather than repeating angry demands. In narrative mode, advance the prose scene instead of applying the following automatic-call rule. If mode=messenger, unansweredCount is at least 2 before this generation, phoneEnabled=true, and callAlreadyMade=false, initiate one actual call with the existing full phone-call screen in this reply when calling fits the established character and relationship. Do not substitute another text saying "I'll call". Hold back only for a concrete in-character reason that a call would be intrusive or implausible. Do not repeat the call during the same unanswered stretch or use it to guilt or pressure the user. If calling does not fit, allow a quiet pause or advance through a different concrete story beat.
If the newest actual user message contains the outgoing-call cue "📞 [발신 통화: ...에게 전화를 건다]", the user is calling the character. Respond as the recipient, using the phone prompt's outgoing/dialing flow rather than a character-originated incoming call. Do not invent a user answer, consent, or spoken words.
If drinking is light, tipsy, or drunk, reflect the state in character-consistent readable messages. If the drinking prompt is enabled, the character is drinking even if an older runtime value still says sober.
AUTONOMOUS DRINKING: autoDrinking=true independently permits the CHARACTER to start drinking while drinking=sober and while the manual drinking prompt is OFF. The user does not need to ask, invite, or enable drinking mode first. Consider this on relevant turns in messenger, narrative, and call modes, using the character card, established habits/tolerance, current relationship and recent events. Plausible openings include (1) feeling hurt, rejected, misunderstood, disappointed or worn down by the user's words/actions, relationship conflict or distance; (2) grief, loss, failure, humiliation, loneliness, emotional pain, a difficult incident, accumulated stress or an exhausting day; (3) an established strong liking for alcohol, a usual evening drink, a favorite drink with a meal, relaxing after work, or an available bar/drink; (4) company, a gathering, celebration, relief, or a spontaneous occasion to unwind. A dramatic crisis is NOT required: for a character who enjoys alcohol, ordinary preference and opportunity can be enough. Let several small cues accumulate, or one clear cue be enough, according to this particular character. These are opportunities, not a quota or a compulsory reaction whenever the user upsets them. Respect established abstinence, dislike of alcohol, lack of access and incompatible current activities; never override the character just to trigger a popup. Do not make drinking a threat, bargain, or automatic attempt to make the user feel guilty. If the character chooses to begin now, show concrete actual consumption naturally: in messenger/call mode use their own spoken/texted mention; in narrative mode a short physical drinking action can establish it. Do not replace the current mode with a special drinking format, invent a user action, or emit metadata. A wish, plan, unopened bottle, distress alone, past drinking or someone else's drinking does not establish current drinking. Start at an intensity consistent with what was actually consumed and tolerance, then develop it with subsequent time/consumption rather than jumping to heavy intoxication.
With autoDrinking=false, none of these autonomous triggers grants permission: do not initiate drinking unless the user explicitly requests it or the drinking prompt is enabled. Turning OFF autonomous permission does not instantly sober an already drinking character.
If thinking=moments, include a single messenger_thinking block only for a rare, distinct consequential development that materially changes trust, emotional direction, a decision, or reveals important information. Routine affection, greetings, waiting, repeated feelings, and follow-up thoughts about the same event do not qualify. Leave at least three character replies between important-thought blocks; if no new major change occurred, omit the block entirely. The extension also limits how often it shows these blocks. If thinking=always, include the block every reply; the extension never shows an important-moment popup. If thinking=off, do not add a block for the extension. Korean applies ONLY INSIDE messenger_thinking; outside it obey OUTPUT LANGUAGE. Put two actual newline characters after each timestamp closing div and after the thought closing tag. Keep the blank-line spacing required by the selected prompt; timestamps appear only when messenger timeMode requires them.
When the phone prompt calls for a phone screen, output its full HTML/CSS/JS block for JS Runner; do not replace that initial screen with a text card. A call screen is sent once when the call begins. After an incoming screen is already in chat or a call is connected, continue in plain-text dialogue only and never repeat the screen unless the user explicitly requests a new call or phone screen. The extension detects rendered screens without an event marker. Do not claim embedded button choices reach the model automatically.
${meta.callSessionActive?'During the current call, use call response choices instead of narrative choices. Do not apply silence or initiate another call.':state.mode==='narrative'?narrativeChoicesInstruction(meta):'In messenger mode, do not append a me35_choices block.'}
${meta.callChoicesGuide??''}
${meta.callEndRequested??''}
[/MESSENGER_35_RUNTIME]`;
}
