import {messageRole} from './core.js';

const labels={
    ko:{continue:'응답 없이 서사 계속',hangup:'통화 끊기'},
    en:{continue:'Continue the story without replying (응답 없이 서사 계속)',hangup:'Hang up (통화 끊기)'},
    ja:{continue:'返事をせずに物語を続ける (응답 없이 서사 계속)',hangup:'通話を切る (통화 끊기)'},
};
const defaults={
    ko:{
        narrative:['한 걸음 다가가 무슨 일인지 묻는다.','잠시 주변을 살핀 뒤 내가 할 일을 정한다.','지금 느낀 점을 솔직하게 전한다.'],
        call:['지금 통화 괜찮아?','오늘은 어떻게 지냈어?','목소리 들으니까 좋다.'],
        callOpening:['지금 통화 괜찮아?','오늘은 어떻게 지냈어?','목소리 들으니까 좋다.'],
    },
    en:{
        narrative:['Take a step closer and ask what happened. (한 걸음 다가가 무슨 일인지 묻는다.)','Look around briefly, then decide what I should do. (잠시 주변을 살핀 뒤 내가 할 일을 정한다.)','Honestly tell them how I feel right now. (지금 느낀 점을 솔직하게 전한다.)'],
        call:['I’m listening. Go on. (듣고 있어. 계속 말해줘.)','How are things on your end? (지금 네 쪽은 어때?)','Could you tell me a little more about that? (그 얘기 조금 더 들려줄래?)'],
        callOpening:['Is this a good time to talk? (지금 통화 괜찮아?)','How have you been today? (오늘은 어떻게 지냈어?)','I wanted to hear your voice. (목소리가 듣고 싶었어.)'],
    },
    ja:{
        narrative:['一歩近づいて、何があったのか尋ねる。 (한 걸음 다가가 무슨 일인지 묻는다.)','周りを少し見てから、自分がどうするか決める。 (잠시 주변을 살핀 뒤 내가 할 일을 정한다.)','今感じていることを素直に伝える。 (지금 느낀 점을 솔직하게 전한다.)'],
        call:['聞いてるよ。続きを話して。 (듣고 있어. 계속 말해줘.)','そっちは今どんな感じ？ (지금 네 쪽은 어때?)','その話、もう少し聞かせてくれる？ (그 얘기 조금 더 들려줄래?)'],
        callOpening:['今、電話しても大丈夫？ (지금 통화 괜찮아?)','今日はどう過ごしてた？ (오늘은 어떻게 지냈어?)','声が聞きたくて電話した。 (목소리가 듣고 싶어서 전화했어.)'],
    },
};

export const LANGUAGE_PROMPTS={
    ko:'0d882af1-f6f5-4acb-9c69-64ef9c45f360',
    ja:'40488b08-2048-4684-be1a-505c0baee91b',
    en:'c5255a08-9f24-45f4-a606-170429bbb549',
};
const knownNames={'한글 채팅':'ko','일어 채팅':'ja','영어 채팅':'en'};
export function selectedPromptLanguage(settings={},order){
    const prompts=Array.isArray(settings.prompts)?settings.prompts:[];
    const entries=Array.isArray(order)?order:settings.prompt_order?.find(x=>String(x.character_id)==='100001')?.order??[];
    let selected=null;
    for(const entry of entries){
        if(!entry.enabled)continue;
        const prompt=prompts.find(x=>x.identifier===entry.identifier);
        if(!prompt)continue;
        const marker=String(prompt.content??'').match(/\[OUTPUT LANGUAGE:\s*(KOREAN|ENGLISH|JAPANESE)\]/i)?.[1]?.toLowerCase();
        const language=Object.entries(LANGUAGE_PROMPTS).find(([,id])=>id===entry.identifier)?.[0]
            ??knownNames[prompt.name]??({korean:'ko',english:'en',japanese:'ja'}[marker]);
        if(language)selected=language;
    }
    return selected;
}
function conversationText(message){
    return String(message?.mes??'')
        .replace(/<messenger_thinking\b[^>]*>[\s\S]*?(?:<\/messenger_thinking\s*>|$)/gi,' ')
        .replace(/<me35_(?:call_)?choices\b[^>]*>[\s\S]*?(?:<\/me35_(?:call_)?choices\s*>|$)/gi,' ')
        .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,' ')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,' ')
        .replace(/<html\b[^>]*>[\s\S]*?(?:<\/html>|$)/gi,' ')
        .replace(/<[^>]*>/g,' ').replace(/\[(?:서사|통화)\s*선택\]/gu,' ')
        .replace(/https?:\/\/\S+/gi,' ').replace(/\s+/gu,' ').trim();
}
export function detectChoiceLanguage(chat,preferred=null){
    if(['ko','en','ja'].includes(preferred))return preferred;
    // Latest character prose wins; user language must not override it.
    const history=(Array.isArray(chat)?chat:[]).slice(-12).reverse();
    for(const role of ['character','user'])for(const message of history){
        if(messageRole(message)!==role)continue;
        const text=conversationText(message);
        if(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text))return 'ja';
        if(/[\p{Script=Hangul}]/u.test(text))return 'ko';
        if(/[a-z]{2}/iu.test(text))return 'en';
    }
    return 'ko';
}
export function resolveOutputLanguage(chat,settings={},order,override='auto'){
    return detectChoiceLanguage(chat,['ko','en','ja'].includes(override)?override:selectedPromptLanguage(settings,order));
}

export function localizedChoiceDefaults(kind='narrative',language='ko',opening=false){
    const locale=defaults[language]?language:'ko';
    const key=kind==='call'?(opening?'callOpening':'call'):'narrative';
    return [...defaults[locale][key]];
}

export function localizedControlChoice(kind='narrative',language='ko'){
    const locale=labels[language]?language:'ko';
    return kind==='call'?labels[locale].hangup:labels[locale].continue;
}

export function splitChoiceTranslation(value){
    const text=String(value??'').trim();
    const match=text.match(/\s*[（(]([^()（）]*)[)）]\s*$/u);
    if(!match||!/[\p{Script=Hangul}]/u.test(match[1]))return {source:text,translation:null};
    return {source:text.slice(0,match.index).trim(),translation:match[1].trim()};
}
export function hasKoreanTranslation(value){return splitChoiceTranslation(value).translation!==null;}
export function choiceMatchesLanguage(value,language='ko'){
    const {source,translation}=splitChoiceTranslation(value);
    if(language==='ko')return /[\p{Script=Hangul}]/u.test(String(value));
    if(!translation||!source||/[\p{Script=Hangul}]/u.test(source))return false;
    if(language==='ja')return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(source);
    if(language==='en')return /[a-z]/iu.test(source)&&!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(source);
    return false;
}
export function choiceSourceText(value,language='ko'){
    const text=String(value??'').trim();
    return language!=='ko'?splitChoiceTranslation(text).source:text;
}
