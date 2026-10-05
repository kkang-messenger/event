import {styleMessageTimestamps,timestampNodes,initializeThoughtCards,prepareRawThoughtCards} from './message-presentation.js?v=3.5.55';
import {classifyMessengerPreset,createPresetGuard} from './preset-guard.js?v=3.5.55';
import {choiceHost,placeChoicePanel,revealDirectInput,setChoiceRetryLoading} from './choice-ui.js?v=3.5.55';
import {updateViewportLayout,watchViewportLayout,viewportBox} from './layout.js?v=3.5.55';
import {KEY,hash,messageKey,messageRole,hasUserContent,freshMeta,derive,canSuggest,containsThought,shouldNotifyThought,inferPhoneType,inferDrinkingStart,inferDrinkingEnd,narrativeOpportunity,runtimePrompt,refreshRequestState,validScenarioTime,splitNarrativeChoices,normalizeKoreanSilence,normalizeThoughtSpacing,NARRATIVE_CONTINUE_LABEL} from './core.js?v=3.5.55';
import {CALL_END_LABEL,CALL_END_CONTROL,splitCallChoices,resolveCallState,inferCallPhase,callChoicesFor,validCallChoiceRecord,callChoicesInstruction} from './call-choices.js?v=3.5.55';
import {createScenarioClock,recordScenarioTimestamp,resolveScenarioTime,advanceScenarioTime,randomScenarioTime} from './scenario-clock.js?v=3.5.55';
import {watchBackgroundControls} from './theme-controls.js?v=3.5.55';
import {buildChoiceSuggestionPrompt,parseChoiceSuggestions,parseGeneratedChoiceSuggestions,readChoiceUserContext} from './choice-suggestions.js?v=3.5.55';
import {choiceSourceText,resolveOutputLanguage,localizedControlChoice} from './choice-language.js?v=3.5.55';
import {detectPhoneScreen} from './phone-detection.js?v=3.5.55';

const ctx=()=>SillyTavern.getContext();
const DEFAULT_SETTINGS={enabled:true,thinkingMode:'moments',timeMode:'realtime',autoDrinking:true,narrativeChoices:true,theme:'white',loadingStyle:'text',outputLanguage:'auto'};
const PROMPT_IDS={
    thoughtsAlways:'messenger35-thought-always',
    thoughtsMoments:'6dc5162d-7342-4a86-b062-00f4dd78692e',
    narrative:'a6d32b93-8846-4438-a768-4e36522e53ba',
    drinking:'4357fc99-8848-49cb-90bc-bf293b446ef0',
    phone:'0de136a1-519c-4c36-8ff0-8e650bc7ae47',
    readSkip:'1e57cea5-ff76-49fe-ada8-e331babe80da',
    timeOff:'90d63b54-7099-48ce-8df9-538003964e4f',
    timeShown:'835a5dde-4de9-4d57-a657-31ac77c49d21',
    realtime:'10dc8af6-5d7f-4d22-bc02-2fb762d8c529',
};
let promptManager=null;
let bindViewport=()=>{};
let busy=false,generation=null,activeDialog=null,settingsDialog=null,renderQueued=false,menuObserver=null,thoughtObserver=null,thoughtRoot=null,choiceDispatch=null;
let loadingWait=false,loadingWatchdog=null,loadingMonitor=null,loadingSawGenerating=false,loadingStartedAt=0,timeNoticeInFlight=null,lastObservedTimeMode=null;
let loadingAnchor=null,loadingResizeObserver=null;
let suggestionJob=null;
const suggestionAttempts=new Map();
const suggestionRefreshes=new Set();
let suggestionEpoch=0;
let layoutHooksRegistered=false;
const displayedClockNodes=new WeakMap();
const drinkLabels={sober:'술을 마시지 않는 중',light:'가볍게 마시는 중',tipsy:'취기가 오른 상태',drunk:'많이 취한 상태'};

function el(tag,text='',cls=''){
    const node=document.createElement(tag);
    if(text)node.textContent=text;
    if(cls)node.className=cls;
    return node;
}
function button(label,fn,primary=false){
    const node=el('button',label,primary?'me35-primary':'');
    node.type='button';
    node.addEventListener('click',()=>Promise.resolve().then(fn).catch(report));
    return node;
}
function report(error){console.error('[Messenger35]',error);}
function identity(){const c=ctx();return `${c.groupId??''}|${c.characterId??''}|${c.chatId??''}`;}
function available(){const c=ctx();return !c.groupId&&c.characterId!==undefined&&c.chatId!=null;}
function meta(create=false){
    const c=ctx();
    if(!c.chatMetadata)return freshMeta();
    if(!c.chatMetadata[KEY]&&create)c.chatMetadata[KEY]=freshMeta();
    return c.chatMetadata[KEY]??freshMeta();
}
function preferences(){
    const store=ctx().extensionSettings;
    if(!store)return DEFAULT_SETTINGS;
    let changed=false;
    if(!store[KEY]){store[KEY]={...DEFAULT_SETTINGS};changed=true;}
    const settings=store[KEY];
    if(!['auto','ko','en','ja'].includes(settings.outputLanguage)){settings.outputLanguage='auto';changed=true;}
    if(typeof settings.enabled!=='boolean'){settings.enabled=DEFAULT_SETTINGS.enabled;changed=true;}
    if(!['always','moments'].includes(settings.thinkingMode)){settings.thinkingMode=DEFAULT_SETTINGS.thinkingMode;changed=true;}
    if(typeof settings.autoDrinking!=='boolean'){settings.autoDrinking=DEFAULT_SETTINGS.autoDrinking;changed=true;}
    if(typeof settings.narrativeChoices!=='boolean'){settings.narrativeChoices=DEFAULT_SETTINGS.narrativeChoices;changed=true;}
    if(!['white','purple','pink','blue','green'].includes(settings.theme)){settings.theme='white';changed=true;}
    if(!['off','shown','realtime'].includes(settings.timeMode)){settings.timeMode=DEFAULT_SETTINGS.timeMode;changed=true;}
    if(!['off','text','bubble'].includes(settings.loadingStyle)){
        settings.loadingStyle=DEFAULT_SETTINGS.loadingStyle;
        changed=true;
    }
    if(changed)ctx().saveSettingsDebounced?.();
    return settings;
}
function promptCompatibility(){
    return classifyMessengerPreset(ctx().chatCompletionSettings,promptOrder(),[
        PROMPT_IDS.phone,PROMPT_IDS.narrative,PROMPT_IDS.timeOff,PROMPT_IDS.timeShown,PROMPT_IDS.realtime,
    ]);
}
const presetGuard=createPresetGuard({
    snapshot:()=>({enabled:preferences().enabled,kind:promptCompatibility()}),
    canShow:()=>!activeDialog&&!busy&&document.body?.dataset.generating!=='true',
    show:()=>modal('메신저 전용 확장이 켜져있습니다.',
        '다른 프롬을 사용하는 것이 감지되었습니다. 메신저 프롬 확장을 OFF 해주세요.',
        [['확장 끄기',true,true],['취소',false]],'!', 'me35-preset-warning'),
    disable:async()=>{
        preferences().enabled=false;stopLoading();
        ctx().saveSettingsDebounced?.();sync();renderAll();
    },
    close:()=>{if(activeDialog?.dialog.classList.contains('me35-preset-warning'))finishDialog(null);},
    onError:report,
});
function active(){return available()&&preferences().enabled&&promptCompatibility()==='compatible';}
function promptOrder(){
    if(promptManager?.activeCharacter)return promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
    return ctx().chatCompletionSettings?.prompt_order?.find(item=>String(item.character_id)==='100001')?.order??null;
}
function presetFlag(identifier){
    const settings=ctx().chatCompletionSettings;
    if(!settings?.prompts?.some(prompt=>prompt.identifier===identifier))return null;
    const order=promptOrder();
    return order?order.some(item=>item.identifier===identifier&&item.enabled):null;
}
function outputLanguage(){return resolveOutputLanguage(ctx().chat??[],ctx().chatCompletionSettings??{},promptOrder(),preferences().outputLanguage);}
function setPresetFlag(identifier,enabled){
    const settings=ctx().chatCompletionSettings;
    if(!settings?.prompts?.some(prompt=>prompt.identifier===identifier))return false;
    const entry=promptOrder()?.find(item=>item.identifier===identifier);
    if(!entry||entry.enabled===enabled)return false;
    entry.enabled=enabled;
    if(promptManager){
        const counts=promptManager.tokenHandler?.getCounts();
        if(counts)counts[identifier]=null;
        promptManager.render(false);
        Promise.resolve(promptManager.saveServiceSettings()).catch(report);
    }
    const save=ctx().saveSettingsDebounced;
    if(typeof save==='function')save();
    return true;
}
function setThoughtPromptMode(mode){
    const always=mode==='always';
    const changedA=setPresetFlag(PROMPT_IDS.thoughtsAlways,always);
    const changedM=setPresetFlag(PROMPT_IDS.thoughtsMoments,!always);
    return changedA||changedM;
}
function readThoughtPromptMode(){
    const always=presetFlag(PROMPT_IDS.thoughtsAlways),moments=presetFlag(PROMPT_IDS.thoughtsMoments);
    if(always===true&&moments!==true)return 'always';
    if(moments===true&&always!==true)return 'moments';
    return null;
}
const timePromptIds={off:PROMPT_IDS.timeOff,shown:PROMPT_IDS.timeShown,realtime:PROMPT_IDS.realtime};
function timePromptsAvailable(){return Object.values(timePromptIds).every(identifier=>presetFlag(identifier)!==null);}
function readTimePromptMode(){
    if(!timePromptsAvailable())return null;
    const enabled=Object.entries(timePromptIds).filter(([,identifier])=>presetFlag(identifier)===true);
    return enabled.length===1?enabled[0][0]:null;
}
function setTimePromptMode(mode){
    if(!timePromptIds[mode]||!timePromptsAvailable())return false;
    const order=promptOrder();
    const counts=promptManager?.tokenHandler?.getCounts();
    let changed=false;
    for(const [key,identifier] of Object.entries(timePromptIds)){
        const entry=order.find(item=>item.identifier===identifier);
        const enabled=key===mode;
        if(entry.enabled===enabled)continue;
        entry.enabled=enabled;changed=true;
        if(counts)counts[identifier]=null;
    }
    if(changed){
        promptManager?.render(false);
        if(promptManager)Promise.resolve(promptManager.saveServiceSettings()).catch(report);
        ctx().saveSettingsDebounced?.();
    }
    return changed;
}
function effectiveMeta(){
    const settings=preferences();
    const narrative=presetFlag(PROMPT_IDS.narrative);
    const thought=readThoughtPromptMode();
    const phone=presetFlag(PROMPT_IDS.phone);
    const call=ongoingCallState();
    const data=meta(),chat=ctx().chat??[];
    const scenarioCurrentTime=call.active&&readTimePromptMode()==='shown'&&data.callClock?.sessionKey===call.sourceKey&&validScenarioTime(data.callClock.time)
        ?data.callClock.time:resolveScenarioTime(data,chat);
    return {...data,outputLanguage:outputLanguage(),narrativeEnabled:narrative===true,phoneEnabled:phone===true,readSkipEnabled:presetFlag(PROMPT_IDS.readSkip)===true,
        narrativeChoicesEnabled:settings.narrativeChoices&&narrative===true,characterName:ctx().name2,
        callSessionActive:phone===true&&call.active&&choiceDispatch?.kind!=='call-end',callChoicesGuide:phone===true?callChoicesInstruction(choiceDispatch?.kind==='call-end'?{...call,active:false,phase:'ended'}:call):'',
        callEndRequested:choiceDispatch?.kind==='call-end'?CALL_END_CONTROL:'',
        scenarioCurrentTime,
        thinking:thought??'off',timeMode:readTimePromptMode()??'off',autoDrinking:settings.autoDrinking};
}
function ongoingCallState(){
    const state=resolveCallState(ctx().chat??[]);
    if(state.sourceKey&&meta().closedCalls?.[state.sourceKey])return {...state,active:false,phase:'ended'};
    return state;
}
function ensureCallClock(){
    if(readTimePromptMode()!=='shown')return;
    const c=ctx(),call=ongoingCallState();
    if(!call.active||!call.sourceKey)return;
    const data=meta(true);
    if(data.callClock?.sessionKey===call.sourceKey&&validScenarioTime(data.callClock.time))return;
    const startingTime=resolveScenarioTime({...data,callClock:null},c.chat??[])??randomScenarioTime();
    data.callClock={sessionKey:call.sourceKey,turns:0,time:startingTime,lastIndex:call.originIndex,lastKey:null};
    Promise.resolve(c.saveMetadata?.()).catch(report);
}
async function savePreferences(){
    setThoughtPromptMode(preferences().thinkingMode);
    const save=ctx().saveSettingsDebounced;
    if(typeof save==='function')save();
    sync();
    renderAll();
    setTimeout(queueChoiceSuggestions,0);
}
async function syncPreset(){
    if(!active()||busy)return;
    const thoughtMode=readThoughtPromptMode();
    if(thoughtMode&&thoughtMode!==preferences().thinkingMode){
        preferences().thinkingMode=thoughtMode;
        const save=ctx().saveSettingsDebounced;
        if(typeof save==='function')save();
    }
    let timeMode=readTimePromptMode();
    if(!timeMode&&timePromptsAvailable()){
        setTimePromptMode(preferences().timeMode);
        timeMode=readTimePromptMode();
    }
    const timeModeChanged=lastObservedTimeMode!==null&&timeMode!==lastObservedTimeMode;
    lastObservedTimeMode=timeMode;
    if(timeMode&&timeMode!==preferences().timeMode){
        preferences().timeMode=timeMode;
        ctx().saveSettingsDebounced?.();
    }
    if(timeMode)await maybeShowTimeNotice(false,timeModeChanged);
    const id=identity(),data=meta(true),value=presetFlag(PROMPT_IDS.drinking);
    if(value===null||data.presetDrinking===value){sync();return;}
    const previous=data.presetDrinking;
    data.presetDrinking=value;
    const current=derive(data,ctx().chat??[]).drinking;
    const shouldEnter=value&&current==='sober',shouldExit=!value&&previous===true&&current!=='sober';
    if(shouldEnter||shouldExit){
        data.actions.push({source:lastKey(),drinking:shouldEnter?'light':'sober'});
        await persist();
        if(shouldEnter&&id===identity()&&active()){
            await modal('캐릭터가 음주를 시작합니다','말하지 못했던 진심이 대화 사이로 새어 나올 수도 있습니다.',[['확인',true,true]],'🥃');
        }
    }else await persist();
}
async function persist(){await ctx().saveMetadata();sync();}
function lastKey(){const chat=ctx().chat;return chat.length?messageKey(chat[chat.length-1],chat.length-1):null;}
async function action(patch,source=lastKey()){
    meta(true).actions.push({...patch,source});
    await persist();
    renderAll();
}
function thoughtCards(block){
    if(active())prepareRawThoughtCards(block);
    return [...(block?.querySelectorAll('details')??[])].filter(details=>
        details.classList.contains('me35-thought')||
        /속마음\s*보기/.test(details.querySelector('summary')?.textContent??''));
}
function repairThoughtBubbleLayout(body){
    let changed=false;
    for(const details of thoughtCards(body)){
        const parent=details.parentNode;
        if(!parent||details.closest('pre,code,.phone-frame'))continue;
        const nodes=[];
        for(let node=details.nextSibling;node;node=node.nextSibling){
            if(node.nodeType===3){nodes.push(node);continue;}
            if(node.nodeType!==1)break;
            if(!['BR','A','B','STRONG','EM','I','U','S','DEL','Q','SPAN','CODE','SMALL','SUP','SUB'].includes(node.tagName))break;
            if(node.querySelector('iframe,.phone-frame,script,style,button,input,textarea'))break;
            nodes.push(node);
        }
        if(!nodes.some(node=>node.textContent?.trim()))continue;
        const paragraph=el('p');
        parent.insertBefore(paragraph,nodes[0]);
        for(const node of nodes)paragraph.append(node);
        changed=true;
    }
    return changed;
}
function normalizeShownTimestamp(body){
    const shown=readTimePromptMode()==='shown';
    let changed=false;
    for(const timestamp of timestampNodes(body)){
        if(!shown){
            const original=displayedClockNodes.get(timestamp);
            if(original){timestamp.replaceChildren(...original);displayedClockNodes.delete(timestamp);changed=true;}
            continue;
        }
        const match=/^\s*\d{1,2}\.\d{1,2},\s*(\d{2}:\d{2})\s*$/u.exec(timestamp.textContent??'');
        if(match){displayedClockNodes.set(timestamp,[...timestamp.childNodes]);timestamp.textContent=match[1];changed=true;}
    }
    return changed;
}
function registerLayoutHooks(){
    if(layoutHooksRegistered)return;
    const formatter=ctx().messageFormatter;
    if(!formatter?.addHook||!formatter.stage?.BEFORE_REGEX||!formatter.stage?.AFTER_MARKDOWN)return;
    const characterOutput=info=>!info.isUser&&!info.isSystem&&!info.isReasoning;
    formatter.addHook((text,info)=>active()&&characterOutput(info)?normalizeThoughtSpacing(text):text,
        {stage:formatter.stage.BEFORE_REGEX,order:formatter.order?.EARLY??10});
    formatter.addHook((html,info)=>{
        if(!active()||!characterOutput(info)||(!html.includes('속마음')&&!html.includes('me35-thought')))return html;
        const template=document.createElement('template');template.innerHTML=html;
        const repaired=repairThoughtBubbleLayout(template.content);
        return repaired?template.innerHTML:html;
    },{stage:formatter.stage.AFTER_MARKDOWN,order:formatter.order?.LATEST??100});
    layoutHooksRegistered=true;
}
function sync(){
    presetGuard.check();
    document.documentElement.dataset.me35Theme=preferences().theme;
    const themeSelect=document.querySelector('#me35-theme');
    if(themeSelect)themeSelect.value=preferences().theme;
    const c=ctx(),settings=preferences(),current=effectiveMeta(),state=derive(current,c.chat??[]),usable=active();
    ctx().setExtensionPrompt(KEY,usable?runtimePrompt(current,ctx().chat):'',1,0,false,0);
    document.documentElement.classList.remove('me35-hide-thoughts');
    const menuToggle=document.querySelector('#me35-menu-toggle');
    if(menuToggle){
        const status=menuToggle.querySelector('.me35-menu-status');
        if(status)status.textContent=settings.enabled?'ON':'OFF';
        menuToggle.setAttribute('aria-label',`스마트폰 메신저 설정 열기, ${settings.enabled?'ON':'OFF'}`);
        menuToggle.classList.toggle('is-enabled',settings.enabled);
    }
    const modeButton=document.querySelector('#me35-panel-mode');
    if(modeButton){
        const mode=state.mode==='narrative';
        modeButton.textContent=mode?'메신저로 돌아가기':'서사 시작';
        modeButton.disabled=!usable||busy||presetFlag(PROMPT_IDS.narrative)===null;
        modeButton.classList.toggle('is-narrative',mode);
    }
    const radio=document.querySelector(`input[name="me35-thinking-mode"][value="${settings.thinkingMode}"]`);
    if(radio)radio.checked=true;
    const timeMode=readTimePromptMode();
    for(const input of document.querySelectorAll('input[name="me35-time-mode"]')){
        input.checked=input.value===timeMode;
        input.disabled=!timePromptsAvailable();
    }
    const timeStatus=document.querySelector('#me35-time-status');
    if(timeStatus)timeStatus.textContent=timeMode==='shown'
        ?`현재 시각: ${resolveScenarioTime(meta(),c.chat??[])??'미설정 (임의 시작)'}`:'';
    const changeTime=document.querySelector('#me35-change-time');
    if(changeTime)changeTime.disabled=!usable||busy||timeMode!=='shown';
    const loadingRadio=document.querySelector(`input[name="me35-loading-style"][value="${settings.loadingStyle}"]`);
    if(loadingRadio)loadingRadio.checked=true;
    const enabledInput=document.querySelector('#me35-panel-enabled');
    if(enabledInput)enabledInput.checked=settings.enabled;
    const enabledStatus=document.querySelector('#me35-panel-enabled-status');
    if(enabledStatus)enabledStatus.textContent=settings.enabled?'ON':'OFF';
    const narrativeInput=document.querySelector('#me35-panel-narrative');
    if(narrativeInput){const value=presetFlag(PROMPT_IDS.narrative);narrativeInput.checked=value===true;narrativeInput.disabled=value===null;}
    const choicesInput=document.querySelector('#me35-panel-narrative-choices');
    if(choicesInput){choicesInput.checked=settings.narrativeChoices;choicesInput.disabled=!usable||(presetFlag(PROMPT_IDS.narrative)!==true&&presetFlag(PROMPT_IDS.phone)!==true);}
    const readSkipInput=document.querySelector('#me35-panel-read-skip');
    if(readSkipInput){const value=presetFlag(PROMPT_IDS.readSkip);readSkipInput.checked=value===true;readSkipInput.disabled=value===null;}
    const drinkingInput=document.querySelector('#me35-panel-drinking');
    if(drinkingInput){const value=presetFlag(PROMPT_IDS.drinking);drinkingInput.checked=value===true;drinkingInput.disabled=value===null;}
    const phoneInput=document.querySelector('#me35-panel-phone');
    if(phoneInput){const value=presetFlag(PROMPT_IDS.phone);phoneInput.checked=value===true;phoneInput.disabled=value===null;}
    const autoDrinkingInput=document.querySelector('#me35-panel-auto-drinking');
    if(autoDrinkingInput)autoDrinkingInput.checked=settings.autoDrinking;
    const callButton=document.querySelector('#me35-panel-call');
    if(callButton)callButton.disabled=!usable||busy||Boolean(choiceDispatch)||document.body?.dataset.generating==='true'||presetFlag(PROMPT_IDS.phone)===null;

    if(active())for(const details of thoughtCards(document.querySelector('#chat'))){
        const block=details.closest('.mes[mesid]'),index=Number(block?.getAttribute('mesid')),message=c.chat[index];
        const key=message?messageKey(message,index):null;
        if(readThoughtPromptMode()==='always'||(key&&current.revealedThoughts?.[key])){
            details.hidden=false;
            initializeThoughtCards([details]);
        }
    }
    renderLoading();
}
function finishDialog(value){
    if(activeDialog)activeDialog.finish(value);
}
function dialogShell(title,body,signal='✦',extraClass=''){
    const previous=document.activeElement,dialog=el('dialog','','me35-modal');
    if(extraClass)dialog.classList.add(extraClass);
    const heading=el('h3',title);heading.id='me35-dialog-title';
    dialog.setAttribute('aria-labelledby',heading.id);
    dialog.append(el('div',signal,'me35-signal'),heading);
    if(body)dialog.append(el('p',body));
    let done=false;
    const finish=value=>{
        if(done)return;
        done=true;
        dialog.close();dialog.remove();
        if(activeDialog?.dialog===dialog)activeDialog=null;
        if(previous?.isConnected)previous.focus();
        dialog._resolve?.(value);
    };
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    document.body.append(dialog);
    updateViewportLayout();
    dialog.showModal();
    activeDialog={dialog,finish};
    return {dialog,finish};
}
function modal(title,body,choices,signal='✦',extraClass=''){
    return new Promise(resolve=>{
        const {dialog,finish}=dialogShell(title,body,signal,extraClass);
        dialog._resolve=resolve;
        const row=el('div','','me35-row');
        for(const [label,value,primary] of choices)row.append(button(label,()=>finish(value),primary));
        dialog.append(row);
    });
}
function scenarioTimeDialog(){
    return new Promise(resolve=>{
        const {dialog,finish}=dialogShell('시간 표시 안내',
            '현재 시간 표시 기능이 켜져있습니다. 시나리오 상 현재 시각을 몇 시로 설정하시겠습니까? (미설정 시 랜덤한 시간대로 대화가 시작됩니다.)','◷','me35-time-dialog');
        dialog._resolve=resolve;
        const label=el('label','시나리오 현재 시각','me35-time-label');
        const input=el('input');input.type='time';input.step='60';input.setAttribute('aria-label','시나리오 현재 시각');
        input.value=resolveScenarioTime(meta(),ctx().chat??[])??'';
        label.append(input);
        const error=el('small','','me35-time-error');error.setAttribute('aria-live','polite');
        const row=el('div','','me35-row');
        row.append(button('시간 설정',()=>{
            if(!validScenarioTime(input.value)){error.textContent='시각을 선택하거나 시간 미설정을 눌러주세요.';input.focus();return;}
            finish({kind:'fixed',time:input.value});
        },true),button('시간 미설정',()=>finish({kind:'random'})));
        dialog.append(label,error,row);
        input.focus();
    });
}
function newChatAtOpening(){
    const messages=(ctx().chat??[]).filter(message=>!message?.is_system);
    return messages.length<=1||(messages.length===2&&messageRole(messages[0])==='character'&&messageRole(messages[1])==='user');
}
async function maybeShowTimeNotice(force=false,allowExisting=false){
    if(!active()||!timePromptsAvailable())return;
    const mode=readTimePromptMode();
    if(mode==='off'||!mode)return;
    const id=identity(),noticeKey=`${id}|${mode}`;
    if(timeNoticeInFlight){
        if(timeNoticeInFlight.key===noticeKey)return timeNoticeInFlight.promise;
        await timeNoticeInFlight.promise;
        return maybeShowTimeNotice(force,allowExisting);
    }
    if(!force&&!allowExisting&&!newChatAtOpening())return;
    if(busy||activeDialog)return;
    if(!force&&meta().timeNotices?.[mode])return;
    const pending={key:noticeKey,promise:null};
    timeNoticeInFlight=pending;
    pending.promise=(async()=>{
        const choice=mode==='shown'
            ?await scenarioTimeDialog()
            :await modal('리얼타임 안내',
                '현재 리얼타임 기능이 켜져있습니다. 실제 한국 시간을 기준으로 대화가 시작합니다. 원하는 시간대가 있을 경우 ‘시간 표시’ 모드로 바꿔주세요.',
                [['확인',true,true]],'◷','me35-time-dialog');
        if(choice===null||id!==identity()||!active()||readTimePromptMode()!==mode)return;
        const data=meta(true);data.timeNotices??={};data.timeNotices[mode]=true;
        if(mode==='shown'){
            if(choice?.kind==='fixed'&&validScenarioTime(choice.time))data.scenarioTime=choice.time;
            else delete data.scenarioTime;
            data.scenarioClock={...createScenarioClock((ctx().chat??[]).length),epoch:hash(`${id}|${Date.now()}|${choice?.time??'random'}`)};
            delete data.callClock;
        }
        await persist();
    })();
    try{
        return await pending.promise;
    }finally{if(timeNoticeInFlight===pending)timeNoticeInFlight=null;}
}
function renderLoading(){
    let indicator=document.querySelector('#me35-loading-indicator');
    const style=preferences().loadingStyle;
    if(!active()||!loadingWait||style==='off'){
        loadingResizeObserver?.disconnect();loadingResizeObserver=null;loadingAnchor=null;
        indicator?.remove();return;
    }
    const sendForm=document.querySelector('#send_form');
    const rect=sendForm?.getBoundingClientRect();
    if(!sendForm||!rect||rect.width<=0||rect.height<=0){
        loadingResizeObserver?.disconnect();loadingResizeObserver=null;loadingAnchor=null;
        indicator?.remove();return;
    }
    if(!indicator){
        indicator=el('div','','me35-loading');indicator.id='me35-loading-indicator';
        indicator.setAttribute('role','status');indicator.setAttribute('aria-live','polite');
    }
    indicator.className=`me35-loading me35-loading-${style}`;
    const name=String(ctx().name2??'캐릭터').replace(/\s+/g,' ').trim()||'캐릭터';
    const label=`${name}${name.endsWith('님')?'':'님'}이 입력 중`;
    if(indicator.dataset.me35Label!==label||indicator.dataset.me35Style!==style){
        indicator.dataset.me35Label=label;indicator.dataset.me35Style=style;
        const dots=el('span','','me35-loading-animated-dots');dots.setAttribute('aria-hidden','true');
        for(let i=0;i<3;i++)dots.append(el('i'));
        indicator.replaceChildren(el('span',label,'me35-loading-label'),dots);
    }
    const viewport=viewportBox(window);
    indicator.style.setProperty('--me35-loading-left',`${Math.min(viewport.left+viewport.width-12,Math.max(viewport.left+12,rect.left+rect.width/2))}px`);
    indicator.style.setProperty('--me35-loading-top',`${Math.max(viewport.top+36,Math.min(rect.top-6,viewport.top+viewport.height-12))}px`);
    indicator.style.setProperty('--me35-loading-width',`${Math.max(1,Math.min(rect.width,viewport.width)-24)}px`);
    // A viewport overlay cannot end up between newly appended chat messages.
    if(indicator.parentElement!==document.body)document.body.append(indicator);
    if(loadingAnchor!==sendForm){
        loadingResizeObserver?.disconnect();loadingResizeObserver=null;
        loadingAnchor=sendForm;
        if(typeof ResizeObserver==='function'){
            loadingResizeObserver=new ResizeObserver(()=>{if(loadingWait)renderLoading();});
            loadingResizeObserver.observe(sendForm);
        }
    }
}
function stopLoading(){
    loadingWait=false;
    loadingResizeObserver?.disconnect();loadingResizeObserver=null;loadingAnchor=null;
    if(loadingWatchdog){clearTimeout(loadingWatchdog);loadingWatchdog=null;}
    if(loadingMonitor){clearInterval(loadingMonitor);loadingMonitor=null;}
    loadingSawGenerating=false;
    loadingStartedAt=0;
    renderLoading();
}
function startLoading(){
    if(!active())return;
    loadingWait=true;
    loadingSawGenerating=document.body?.dataset.generating==='true';
    loadingStartedAt=Date.now();
    if(loadingWatchdog)clearTimeout(loadingWatchdog);
    loadingWatchdog=setTimeout(()=>{stopLoading();console.warn('[Messenger35] Loading indicator expired after five minutes.');},300000);
    if(loadingMonitor)clearInterval(loadingMonitor);
    loadingMonitor=setInterval(()=>{
        renderLoading();
        const generating=document.body?.dataset.generating==='true';
        if(generating)loadingSawGenerating=true;
        if(generating)return;
        const stop=document.querySelector('#mes_stop');
        if(stop&&getComputedStyle(stop).display!=='none')return;
        if(!loadingSawGenerating&&Date.now()-loadingStartedAt<10000)return;
        const chat=ctx().chat??[];
        if(generation?.before&&chat.some((message,index)=>messageRole(message)==='character'&&!generation.before.includes(messageKey(message,index))))return;
        if(choiceDispatch)return;
        busy=false;generation=null;stopLoading();sync();queueRender();
    },750);
    renderLoading();
}
async function prepareOutgoingCall(){
    if(!active()||busy||choiceDispatch||document.body?.dataset.generating==='true'||!available())return;
    const phone=presetFlag(PROMPT_IDS.phone);
    if(phone===null){
        await modal('통화 기능을 사용할 수 없습니다','스마트폰 메신저 3.5 프리셋의 폰 화면 전송 항목을 찾지 못했습니다.',[['확인',true,true]],'☎');
        return;
    }
    const textarea=document.querySelector('#send_textarea');
    if(!(textarea instanceof HTMLTextAreaElement)){
        await modal('입력창을 찾지 못했습니다','SillyTavern 채팅 입력창이 표시된 상태에서 다시 시도해 주세요.',[['확인',true,true]],'☎');
        return;
    }
    if(typeof ctx().generate!=='function')return;
    if(!phone){
        setPresetFlag(PROMPT_IDS.phone,true);
        if(presetFlag(PROMPT_IDS.phone)!==true)return;
    }
    const name=String(ctx().name2??'캐릭터').replace(/\s+/g,' ').trim()||'캐릭터';
    const cue=`📞 [발신 통화: ${name}에게 전화를 건다]`;
    const id=identity(),token={id,kind:'outgoing-call'};choiceDispatch=token;
    const restoreDraft=prepareChoiceDraft(textarea,cue,id,()=>{if(id===identity())closeSettings();});token.restoreDraft=restoreDraft;
    sync();renderAll();
    try{await ctx().generate('normal');}
    finally{
        restoreDraft();
        if(choiceDispatch===token)choiceDispatch=null;
        sync();queueRender();setTimeout(queueChoiceSuggestions,0);
    }
}
async function toggleModeImmediately(){
    if(!active()||busy||presetFlag(PROMPT_IDS.narrative)===null)return;
    const current=derive(effectiveMeta(),ctx().chat??[]).mode;
    if(current==='narrative'){
        const accepted=await modal('메신저 모드로 돌아갈까요?','서사 모드를 종료하고 메신저 모드로 돌아갑니다.',
            [['메신저로 돌아가기',true,true],['계속 서사 쓰기',false]],'↩');
        if(accepted&&active())await action({mode:'messenger'});
        return;
    }
    const accepted=await modal('서사를 시작할까요?','메신저 모드가 종료되고 서사 모드로 전환됩니다.',
        [['서사 모드 시작',true,true],['메신저 계속하기',false]],'✦');
    if(!accepted||!active())return;
    if(presetFlag(PROMPT_IDS.narrative)===false)setPresetFlag(PROMPT_IDS.narrative,true);
    await action({mode:'narrative'});
}
function addSettingRow(parent,{id,title,description,checked,disabled=false,onChange}){
    const row=el('label','','me35-setting-row'),input=el('input');
    input.type='checkbox';input.id=id;input.checked=Boolean(checked);input.disabled=disabled;
    const copy=el('span','','me35-preference-copy');copy.append(el('strong',title),el('small',description));
    row.append(input,copy);parent.append(row);
    input.addEventListener('change',()=>Promise.resolve(onChange(input.checked)).catch(report));
    return input;
}
function closeSettings(){
    if(!settingsDialog)return;
    const {dialog,previous}=settingsDialog;
    settingsDialog=null;
    dialog.close();dialog.remove();
    if(previous?.isConnected)previous.focus();
}
function openSettings(){
    if(settingsDialog?.dialog.isConnected){sync();return;}
    const previous=document.activeElement;
    const dialog=el('dialog','','me35-settings-dialog');dialog.id='me35-settings-dialog';
    dialog.setAttribute('aria-labelledby','me35-settings-title');
    const header=el('div','','me35-settings-header');
    const title=el('h3','스마트폰 메신저');title.id='me35-settings-title';
    const close=button('닫기',closeSettings);close.classList.add('me35-settings-close');
    const heading=el('div','','me35-settings-heading');
    const enabledToggle=el('label','','me35-header-toggle');
    enabledToggle.title='확장 켜기: 서사·음주·속마음·폰 화면 상황 알림을 활성화합니다.';
    const enabled=el('input');enabled.type='checkbox';enabled.id='me35-panel-enabled';
    enabled.setAttribute('role','switch');enabled.setAttribute('aria-label','스마트폰 메신저 확장 켜기');
    enabled.checked=preferences().enabled;
    const track=el('span','','me35-toggle-track');track.setAttribute('aria-hidden','true');
    const status=el('span',enabled.checked?'ON':'OFF','me35-toggle-status');status.id='me35-panel-enabled-status';status.setAttribute('aria-hidden','true');
    enabledToggle.append(enabled,track,status);
    enabled.addEventListener('change',()=>Promise.resolve().then(async()=>{
        preferences().enabled=enabled.checked;if(!enabled.checked)stopLoading();
        await savePreferences();await syncPreset();
    }).catch(report));
    heading.append(title,enabledToggle);header.append(heading,close);
    const panel=el('div');panel.id='me35-settings-panel';
    const content=el('div','','me35-settings-content');
    panel.append(content);dialog.append(header,panel);
    const themeRow=el('label','','me35-theme-setting');
    themeRow.append(el('span','확장 테마'));
    const themeSelect=el('select');themeSelect.id='me35-theme';
    for(const [value,label] of [['white','화이트'],['purple','보라'],['pink','핑크'],['blue','블루'],['green','그린']]){
        const option=el('option',label);option.value=value;themeSelect.append(option);
    }
    themeSelect.value=preferences().theme;
    themeSelect.addEventListener('change',()=>{preferences().theme=themeSelect.value;ctx().saveSettingsDebounced?.();sync();});
    themeRow.append(themeSelect);content.append(themeRow);
    const languageRow=el('label','','me35-theme-setting');languageRow.append(el('span','선택지 언어 설정'));
    const languageSelect=el('select');languageSelect.id='me35-output-language';
    for(const [value,label] of [['auto','프롬프트 따르기'],['ko','한국어'],['en','English + 번역'],['ja','日本語 + 번역']]){
        const option=el('option',label);option.value=value;languageSelect.append(option);
    }
    languageSelect.value=preferences().outputLanguage;
    languageSelect.addEventListener('change',()=>{preferences().outputLanguage=languageSelect.value;suggestionEpoch++;suggestionAttempts.clear();suggestionRefreshes.clear();ctx().saveSettingsDebounced?.();sync();queueRender();setTimeout(queueChoiceSuggestions,0);});
    languageRow.append(languageSelect);content.append(languageRow);

    const linkedNote=el('div','','me35-link-note');
    linkedNote.append(el('strong','스마트폰 메신저 프롬과 연동'),el('p','아래 모드 설정은 스마트폰 메신저 프롬과 연동됩니다.','me35-settings-note'));
    content.append(linkedNote);
    const time=el('fieldset','','me35-thinking-settings me35-time-settings');time.append(el('legend','시간 표시'));
    const timeGroup=el('div','','me35-segmented');
    for(const [value,label,description] of [
        ['off','시간 표시 X','시각을 표시하지 않고 메시지만 출력합니다.'],
        ['shown','시간 표시 O','시나리오 시작 시각을 정하거나 임의로 시작합니다. 이후 시간은 전개에 따라 흐릅니다.'],
        ['realtime','리얼타임','실제 한국 시각을 기준으로 표시합니다.'],
    ]){
        const choice=el('label','','me35-thinking-choice'),radio=el('input');
        radio.type='radio';radio.name='me35-time-mode';radio.value=value;
        radio.checked=readTimePromptMode()===value;radio.disabled=!timePromptsAvailable();
        const copy=el('span','','me35-preference-copy');copy.append(el('strong',label),el('small',description));
        choice.append(radio,copy);timeGroup.append(choice);
        radio.addEventListener('change',async()=>{
            if(!radio.checked)return;
            if(!setTimePromptMode(value)){
                if(readTimePromptMode()!==value){sync();return;}
            }
            preferences().timeMode=value;
            await savePreferences();
            await maybeShowTimeNotice(false,true);
        });
    }
    time.append(timeGroup);
    const timeTools=el('div','','me35-time-tools');
    const timeStatus=el('span','','me35-time-status');timeStatus.id='me35-time-status';
    const changeTime=button('현재 시각 다시 설정',()=>maybeShowTimeNotice(true));changeTime.id='me35-change-time';
    timeTools.append(timeStatus,changeTime);time.append(timeTools);content.append(time);
    const thought=el('fieldset','','me35-thinking-settings');thought.append(el('legend','속마음 보기'));
    const group=el('div','','me35-segmented');
    for(const [value,label,description] of [
        ['always','속마음 보기 (항상)','응답마다 속마음 블록을 생성합니다.'],
        ['moments','속마음 보기 (중요한 순간에)','관계·감정이 크게 바뀌는 순간에 속마음 블록을 생성합니다.'],
    ]){
        const choice=el('label','','me35-thinking-choice'),radio=el('input');
        radio.type='radio';radio.name='me35-thinking-mode';radio.value=value;radio.checked=preferences().thinkingMode===value;
        const copy=el('span','','me35-preference-copy');copy.append(el('strong',label),el('small',description));
        choice.append(radio,copy);group.append(choice);
        radio.addEventListener('change',async()=>{
            if(!radio.checked)return;
            preferences().thinkingMode=value;
            if(value==='moments')for(const details of thoughtCards(document.querySelector('#chat')))details.open=false;
            await savePreferences();
        });
    }
    thought.append(group);content.append(thought);
    const promptGroup=el('fieldset','','me35-prompt-settings');promptGroup.setAttribute('aria-label','모드 연동 설정');
    addSettingRow(promptGroup,{
        id:'me35-panel-phone',title:'폰 화면 전송 ON',description:'켜면 캐릭터가 전화를 걸거나 선물을 보낼 수 있습니다. 메모장이나 스케줄, 음악을 물어보면 반응해서 폰 화면을 캡쳐해서 보내줍니다. JS 러너 확장이 필요합니다.',checked:presetFlag(PROMPT_IDS.phone)===true,disabled:presetFlag(PROMPT_IDS.phone)===null,
        onChange:async value=>{setPresetFlag(PROMPT_IDS.phone,value);sync();},
    });
    addSettingRow(promptGroup,{
        id:'me35-panel-narrative',title:'서사 모드 ON',description:'메신저 대화를 하다가 자연스러운 타이밍에 서사 모드로 전환됩니다. ‘서사 시작’ 버튼으로 바로 시작할 수도 있습니다.',checked:presetFlag(PROMPT_IDS.narrative)===true,disabled:presetFlag(PROMPT_IDS.narrative)===null,
        onChange:async value=>{setPresetFlag(PROMPT_IDS.narrative,value);if(!value&&derive(meta(),ctx().chat??[]).mode==='narrative')await action({mode:'messenger'});sync();renderAll();},
    });
    addSettingRow(promptGroup,{
        id:'me35-panel-narrative-choices',title:'선택지 출력',description:'서사 모드나 통화 모드에서 유저 행동의 선택지를 제안합니다.',
        checked:preferences().narrativeChoices,disabled:presetFlag(PROMPT_IDS.narrative)!==true&&presetFlag(PROMPT_IDS.phone)!==true,
        onChange:async value=>{preferences().narrativeChoices=value;await savePreferences();},
    });
    addSettingRow(promptGroup,{
        id:'me35-panel-read-skip',title:'읽씹 연출 ON',description:'상황에 따라 캐릭터가 답장하지 않는 장면을 허용합니다.',
        checked:presetFlag(PROMPT_IDS.readSkip)===true,disabled:presetFlag(PROMPT_IDS.readSkip)===null,
        onChange:async value=>{setPresetFlag(PROMPT_IDS.readSkip,value);sync();},
    });
    addSettingRow(promptGroup,{
        id:'me35-panel-drinking',title:'음주 모드 ON',description:'켜면 캐릭터가 음주 상태가 됩니다.',checked:presetFlag(PROMPT_IDS.drinking)===true,disabled:presetFlag(PROMPT_IDS.drinking)===null,
        onChange:async value=>{setPresetFlag(PROMPT_IDS.drinking,value);await syncPreset();sync();},
    });
    addSettingRow(promptGroup,{
        id:'me35-panel-auto-drinking',title:'캐릭터의 자발적 음주 허용',description:'음주 모드가 꺼져 있어도, 관계의 상처·괴로운 사건·스트레스·평소 술 취향이나 일상적인 기회에 따라 캐릭터가 자발적으로 술을 시작할 수 있습니다.',checked:preferences().autoDrinking,
        onChange:async value=>{preferences().autoDrinking=value;await savePreferences();},
    });
    content.append(promptGroup);
    const loading=el('fieldset','','me35-thinking-settings me35-loading-settings');loading.append(el('legend','로딩 메시지'));
    const loadingGroup=el('div','','me35-segmented');
    for(const [value,label,description] of [
        ['text','기본형','텍스트 옆에서 작은 점이 움직입니다.'],
        ['bubble','말풍선형','깔끔한 둥근 말풍선 안에서 점이 움직입니다.'],
        ['off','끄기','로딩 메시지를 표시하지 않습니다.'],
    ]){
        const choice=el('label','','me35-thinking-choice'),radio=el('input');
        radio.type='radio';radio.name='me35-loading-style';radio.value=value;radio.checked=preferences().loadingStyle===value;
        const copy=el('span','','me35-preference-copy');copy.append(el('strong',label),el('small',description));
        choice.append(radio,copy);loadingGroup.append(choice);
        radio.addEventListener('change',()=>{
            if(!radio.checked)return;
            preferences().loadingStyle=value;
            ctx().saveSettingsDebounced?.();
            renderLoading();
        });
    }
    loading.append(loadingGroup);content.append(loading);
    const modeRow=el('div','','me35-panel-action');
    const mode=button('서사 시작',toggleModeImmediately);mode.id='me35-panel-mode';modeRow.append(mode);content.append(modeRow);
    const callRow=el('div','','me35-panel-action');
    const call=button('☎ 캐릭터에게 전화하기',prepareOutgoingCall);call.id='me35-panel-call';callRow.append(call);content.append(callRow);
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeSettings();});
    document.body.append(dialog);
    settingsDialog={dialog,previous};
    sync();
    updateViewportLayout();
    dialog.showModal();
}
function mountMenu(){
    const menu=document.querySelector('#extensionsMenu');
    if(!menu||document.querySelector('#me35-menu-toggle'))return Boolean(menu);
    const row=el('div','','me35-menu-row list-group-item');row.id='me35-menu-toggle';
    row.setAttribute('role','button');row.setAttribute('tabindex','0');
    row.setAttribute('aria-label','스마트폰 메신저 설정 열기');row.setAttribute('aria-haspopup','dialog');
    row.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        Promise.resolve().then(openSettings).catch(report);
    });
    row.addEventListener('keydown',event=>{
        if(event.key!=='Enter'&&event.key!==' ')return;
        event.preventDefault();event.stopPropagation();
        Promise.resolve().then(openSettings).catch(report);
    });
    const icon=el('div','','fa-solid fa-mobile-screen-button extensionsMenuExtensionButton');
    const copy=el('span','스마트폰 메신저');
    const state=el('span','OFF','me35-menu-status');
    row.append(icon,copy,state);
    menu.prepend(row);
    sync();
    return true;
}
function watchMenu(){
    if(!document.body)return;
    mountMenu();
    if(menuObserver)return;
    menuObserver=new MutationObserver(()=>{
        const menu=document.querySelector('#extensionsMenu');
        if(menu&&!menu.querySelector('#me35-menu-toggle'))mountMenu();
    });
    menuObserver.observe(document.body,{childList:true,subtree:true});
}
function guard(id,key){return active()&&!busy&&identity()===id&&(!key||ctx().chat.some((message,index)=>messageKey(message,index)===key));}
function currentKey(index){const message=ctx().chat[index];return message?messageKey(message,index):null;}
function validSourceIndex(source,chat){
    const index=Number(String(source??'').split(':',1)[0]);
    return Number.isInteger(index)&&chat[index]&&messageKey(chat[index],index)===source?index:-1;
}
function latestUserKey(chat,index){
    for(let i=index;i>=0;i--){
        if(messageRole(chat[i])==='user'&&hasUserContent(chat[i]))return messageKey(chat[i],i);
    }
    return null;
}
async function openThought(index,key,id){
    const findBlock=()=>[...document.querySelectorAll('#chat .mes[mesid]')].find(node=>Number(node.getAttribute('mesid'))===index);
    let block=findBlock();
    for(let attempt=0;!block&&attempt<40;attempt++){
        if(!guard(id,key)||currentKey(index)!==key)return false;
        await new Promise(resolve=>setTimeout(resolve,50));
        block=findBlock();
    }
    if(!block||!guard(id,key))return false;
    renderAll();
    const chatRoot=document.querySelector('#chat')??document.body;
    const details=await new Promise(resolve=>{
        let settled=false;
        const finish=value=>{
            if(settled)return;
            settled=true;observer.disconnect();clearInterval(poll);clearTimeout(timeout);resolve(value);
        };
        const check=()=>{
            if(!guard(id,key)||currentKey(index)!==key){finish(null);return;}
            // Regex or SillyTavern can replace the message node after the popup opens.
            block=findBlock();
            const candidate=thoughtCards(block)[0];
            if(candidate)finish(candidate);
        };
        const observer=new MutationObserver(check);
        observer.observe(chatRoot,{childList:true,subtree:true,attributes:true});
        const poll=setInterval(check,60),timeout=setTimeout(()=>finish(null),10000);
        check();
    });
    if(!details||!guard(id,key))return false;
    block=findBlock();
    let target=thoughtCards(block)[0]??details;
    for(let frame=0;frame<4;frame++){
        if(!guard(id,key))return false;
        block=findBlock();
        target=thoughtCards(block)[0]??target;
        target.hidden=false;
        target.open=true;
        target.setAttribute('open','');
        await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    }
    block=findBlock();
    target=thoughtCards(block)[0]??target;
    target.hidden=false;
    target.open=true;
    target.setAttribute('open','');
    target.scrollIntoView({block:'nearest',behavior:'smooth'});
    return true;
}
async function normalizeGeneratedMessage(index,generatedMode){
    const c=ctx(),message=c.chat[index];
    if(!message||messageRole(message)!=='character')return;
    const raw=String(message.mes??''),split=splitNarrativeChoices(raw),callSplit=splitCallChoices(split.hadBlock?split.body:raw);
    const callState=ongoingCallState();
    const mode=generatedMode??derive(effectiveMeta(),c.chat??[]).mode;
    const readSkip=mode==='messenger'&&presetFlag(PROMPT_IDS.readSkip)===true;
    const phoneDocument=inferPhoneType(raw)!==null;
    let cleanBody=normalizeThoughtSpacing(phoneDocument?raw:callSplit.hadBlock?callSplit.body:(split.hadBlock?split.body:raw));
    if(readSkip)cleanBody=normalizeKoreanSilence(cleanBody,c.name2);
    const callEnabled=preferences().narrativeChoices&&(callState.active||callState.phase==='incoming')&&presetFlag(PROMPT_IDS.phone)===true&&choiceDispatch?.kind!=='call-end'&&cleanBody.trim();
    const choicesEnabled=!callEnabled&&mode==='narrative'&&effectiveMeta().narrativeChoicesEnabled===true&&cleanBody.trim();
    const choiceLanguage=outputLanguage(),personaKey=hash(JSON.stringify(readChoiceUserContext(c)));
    let nextChoices=choicesEnabled?{bodyHash:hash(cleanBody),language:choiceLanguage,personaKey,options:parseChoiceSuggestions(null,'narrative',[],choiceLanguage)}:null;
    const oldChoices=message.extra?.me35Choices;
    const cleanMessage={...message,mes:cleanBody};
    let nextCall=callEnabled?{phase:callState.phase,bodyHash:hash(cleanBody),sourceKey:messageKey(cleanMessage,index),sessionKey:callState.originIndex===index?messageKey(cleanMessage,index):callState.sourceKey,language:choiceLanguage,personaKey,options:callChoicesFor(raw,c.name2,callState,choiceLanguage)}:null;
    const oldCall=message.extra?.me35CallChoices;
    if(nextChoices&&oldChoices?.bodyHash===nextChoices.bodyHash&&oldChoices.language===choiceLanguage&&oldChoices.personaKey===personaKey&&oldChoices.suggestionsGenerated&&oldChoices.suggestionsVersion===2)nextChoices=oldChoices;
    if(nextCall&&oldCall?.bodyHash===nextCall.bodyHash&&oldCall.language===choiceLanguage&&oldCall.personaKey===personaKey&&oldCall.suggestionsGenerated&&oldCall.suggestionsVersion===2)nextCall=oldCall;
    const choicesChanged=JSON.stringify(oldChoices??null)!==JSON.stringify(nextChoices)
        ||JSON.stringify(oldCall??null)!==JSON.stringify(nextCall);
    let displayChanged=false;
    if(!phoneDocument&&typeof message.extra?.display_text==='string'){
        const displayRaw=message.extra.display_text,displaySplit=splitNarrativeChoices(displayRaw);
        let cleanDisplay=displaySplit.hadBlock?displaySplit.body:displayRaw;
        const displayCall=splitCallChoices(cleanDisplay);
        if(displayCall.hadBlock)cleanDisplay=displayCall.body;
        cleanDisplay=normalizeThoughtSpacing(cleanDisplay);
        if(readSkip)cleanDisplay=normalizeKoreanSilence(cleanDisplay,c.name2);
        if(cleanDisplay!==displayRaw){message.extra.display_text=cleanDisplay;displayChanged=true;}
    }
    const bodyChanged=cleanBody!==raw;
    if(!bodyChanged&&!choicesChanged&&!displayChanged)return;
    if(bodyChanged)message.mes=cleanBody;
    if(nextChoices){message.extra??={};message.extra.me35Choices=nextChoices;}
    else if(oldChoices)delete message.extra.me35Choices;
    if(nextCall){message.extra??={};message.extra.me35CallChoices=nextCall;}
    else if(oldCall)delete message.extra.me35CallChoices;
    const swipe=message.swipe_id;
    if(Number.isInteger(swipe)&&swipe>=0){
        if(bodyChanged&&Array.isArray(message.swipes)&&typeof message.swipes[swipe]==='string')message.swipes[swipe]=cleanBody;
        if(Array.isArray(message.swipe_info)&&message.swipe_info[swipe]&&typeof message.swipe_info[swipe]==='object'){
            message.swipe_info[swipe].extra=structuredClone(message.extra??{});
        }
    }
    if(bodyChanged||displayChanged)c.updateMessageBlock?.(index,message);
    await c.saveChat?.();
}
async function observeScenarioClock(index,timeMode,generatedMode){
    const c=ctx(),message=c.chat[index],data=meta(true);
    if(!message||messageRole(message)!=='character')return;
    const enabled=timeMode==='shown'&&(generatedMode??derive(effectiveMeta(),c.chat).mode)!=='narrative';
    message.extra??={};
    if(enabled){
        data.scenarioClock??={...createScenarioClock(index),epoch:hash(`${identity()}|${Date.now()}`)};
        data.scenarioClock.epoch??=hash(`${identity()}|${Date.now()}`);
        data.scenarioClock.startIndex=Math.min(data.scenarioClock.startIndex??index,index);
        message.extra.me35ScenarioClock=data.scenarioClock.epoch;
        data.scenarioClock=recordScenarioTimestamp(data.scenarioClock,c.chat,index);
    }else delete message.extra.me35ScenarioClock;
    const swipe=message.swipe_id;
    if(Number.isInteger(swipe)&&message.swipe_info?.[swipe])message.swipe_info[swipe].extra=structuredClone(message.extra);
    await c.saveChat?.();
}
function callCharacterTurnCount(chat,call,index){
    if(!call?.active||!Number.isInteger(call.originIndex))return 0;
    let turns=0;
    for(let i=Math.max(0,call.originIndex);i<=index&&i<chat.length;i++){
        const message=chat[i];
        if(messageRole(message)!=='character')continue;
        const record=message.extra?.me35CallChoices;
        const raw=String(message.mes??''),phase=inferCallPhase(raw);
        if(phase==='ended')break;
        if(record?.sessionKey===call.sourceKey||(phase&&phase!=='ended'))turns++;
    }
    return turns;
}
async function observeCallClock(index,timeMode,generatedMode){
    if(timeMode!=='shown')return;
    const c=ctx(),message=c.chat[index],call=ongoingCallState();
    if(!message||messageRole(message)!=='character'||!call.active||!call.sourceKey)return;
    const data=meta(true),key=messageKey(message,index),turns=callCharacterTurnCount(c.chat,call,index);
    if(!turns)return;
    const previous=data.callClock;
    if(previous?.sessionKey===call.sourceKey&&previous.lastKey===key)return;
    let current=resolveScenarioTime(data,c.chat);
    const sameSession=previous?.sessionKey===call.sourceKey;
    if(sameSession&&previous.lastIndex===index){
        const messageTime=data.scenarioClock?.observations?.[key];
        data.callClock={...previous,lastKey:key,time:validScenarioTime(messageTime)?messageTime:(previous.time??current)};
    }else{
        const previousTurns=sameSession?previous.turns:0;
        if(sameSession&&validScenarioTime(current))previous.time=current;
        let time=sameSession?(current??previous.time):current;
        const elapsedMinutes=Math.max(0,Math.floor(turns/3)-Math.floor(previousTurns/3));
        if(elapsedMinutes&&validScenarioTime(time))time=advanceScenarioTime(time,elapsedMinutes);
        data.callClock={sessionKey:call.sourceKey,turns,time,lastIndex:index,lastKey:key};
    }
    await persist();
}
async function reconcileScenarioClock(){
    if(!active()||readTimePromptMode()!=='shown'||busy)return;
    const data=meta(),clock=data.scenarioClock;
    if(!clock?.epoch)return;
    const chat=ctx().chat??[];
    const marked=chat.map((message,index)=>({message,index})).filter(({message})=>message.extra?.me35ScenarioClock===clock.epoch);
    let next=clock;
    // Deleting older messages can shift the indices of replies from this clock session.
    if(marked.length)next={...next,startIndex:Math.min(next.startIndex??0,marked[0].index)};
    for(const {index} of marked)next=recordScenarioTimestamp(next,chat,index);
    if(JSON.stringify(next)!==JSON.stringify(clock)){data.scenarioClock=next;await persist();}
}
async function processMessage(index,generatedMode,generatedTimeMode){
    if(!active())return;
    const c=ctx(),message=c.chat[index];
    if(!message||messageRole(message)!=='character')return;
    const id=identity();
    await normalizeGeneratedMessage(index,generatedMode);
    if(id!==identity()||c.chat[index]!==message)return;
    await observeScenarioClock(index,generatedTimeMode??readTimePromptMode(),generatedMode);
    await observeCallClock(index,generatedTimeMode??readTimePromptMode(),generatedMode);
    if(id!==identity()||c.chat[index]!==message)return;
    const data=meta(true),key=messageKey(message,index);
    if(data.seen[key])return;
    const raw=String(message.mes??'');
    const screen=detectPhoneScreen(raw,{callExpected:ongoingCallState().active});
    const phone=screen.type,hasThought=containsThought(raw);
    const state=derive(data,c.chat);
    data.seen[key]=true;data.modes[key]=generatedMode??state.mode;
    await persist();renderAll();
    if(!guard(id,key)||currentKey(index)!==key)return;
    const outgoingCall=phone==='call'&&(screen.direction==='outgoing'||ongoingCallState().direction==='outgoing');
    const phoneNotice={
        screenshot:['화면 캡처가 도착했습니다','캐릭터가 화면을 캡쳐해서 보냈습니다.'],
        call:inferCallPhase(raw)==='ended'?null:outgoingCall?['통화 화면이 열렸습니다','캐릭터에게 건 전화의 통화 화면이 도착했습니다.']:['캐릭터가 전화를 걸어옵니다',''],
        gift:['선물이 도착했습니다','캐릭터가 선물을 보냈습니다.'],
        transfer:['송금 알림','캐릭터가 송금했습니다.'],
    }[phone];
    if(phoneNotice){
        await modal(phoneNotice[0],phoneNotice[1],[['확인',true,true]],phone==='call'?'☎':'✦',phone==='call'&&!phoneNotice[1]?'me35-phone-notice':'');
        if(!guard(id,key))return;
    }
    if(preferences().autoDrinking&&presetFlag(PROMPT_IDS.drinking)!==null&&state.drinking==='sober'&&inferDrinkingStart(raw)){
        data.autoDrinkingActive=true;
        setPresetFlag(PROMPT_IDS.drinking,true);
        data.presetDrinking=true;
        await action({drinking:'light'},key);
        if(!guard(id,key))return;
        await modal('캐릭터가 음주를 시작합니다','말하지 못했던 진심을 내뱉을 수도 있습니다.',[['확인',true,true]],'🥃');
    }else if(data.autoDrinkingActive&&state.drinking!=='sober'&&inferDrinkingEnd(raw)){
        data.autoDrinkingActive=false;
        setPresetFlag(PROMPT_IDS.drinking,false);
        data.presetDrinking=false;
        await action({drinking:'sober'},key);
    }
    if(!guard(id,key))return;
    if(ongoingCallState().active||choiceDispatch?.kind==='call-end'){
        // A phone conversation resumes the mode that was active before the call.
    }else{
        const lastReturn=[...(data.actions??[])].reverse().find(item=>item.mode==='messenger'&&validSourceIndex(item.source,c.chat)>=0);
        const userKey=latestUserKey(c.chat,index);
        const opportunity=narrativeOpportunity(c.chat,index,{
            lastProposalIndex:validSourceIndex(data.lastNarrativeProposalKey,c.chat),
            lastReturnIndex:validSourceIndex(lastReturn?.source,c.chat),
            phoneThisTurn:Boolean(phone),
            silenceAlreadyOffered:Boolean(userKey&&data.lastSilenceOfferUserKey===userKey),
        });
        if(opportunity.offer&&canSuggest(effectiveMeta(),c.chat,index)){
            data.lastNarrativeProposalKey=key;
            if(userKey)data.lastSilenceOfferUserKey=userKey;
            await persist();
            const accepted=await modal('서사 모드가 오픈되었습니다.','메신저 대화를 잠시 멈추고, 이 장면을 서사로 이어가시겠습니까?',
                [['모드 전환',true,true],['메신저 계속',false]],'✦');
            if(!guard(id,key))return;
            if(accepted){
                setPresetFlag(PROMPT_IDS.narrative,true);
                await action({mode:'narrative'},key);
            }else{
                data.declined[key]=index;
                await persist();
            }
        }
    }
    if(!guard(id,key)||!hasThought)return;
    if(shouldNotifyThought(readThoughtPromptMode(),raw)&&thoughtCooldownAllows(data,index,c.chat)){
        data.importantThoughts??={};data.importantThoughts[key]=true;
        await persist();renderAll();
        const accepted=await modal('숨겨진 속마음이 있습니다','속마음을 확인해 보세요.',
            [['확인',true,true]],'✦');
        if(accepted&&guard(id,key)){
            data.revealedThoughts??={};
            data.revealedThoughts[key]=true;
            await persist();
            renderAll();
            await openThought(index,key,id);
        }
    }
}
function thoughtCooldownAllows(data,index,chat){
    const prior=Object.keys(data.importantThoughts??{}).map(key=>validSourceIndex(key,chat)).filter(source=>source>=0&&source<index);
    if(!prior.length)return true;
    const last=Math.max(...prior);
    let replies=0;
    for(let i=last+1;i<=index;i++)if(messageRole(chat[i])==='character')replies++;
    return replies>=3;
}
function latestNarrativeChoices(){
    if(!active()||!preferences().narrativeChoices||presetFlag(PROMPT_IDS.narrative)!==true)return null;
    const c=ctx(),chat=c.chat??[];
    if(derive(effectiveMeta(),chat).mode!=='narrative')return null;
    let index=chat.length-1;
    while(index>=0&&messageRole(chat[index])==='system')index--;
    const message=chat[index];
    if(index<0||messageRole(message)!=='character')return null;
    const key=messageKey(message,index),stored=message.extra?.me35Choices,language=outputLanguage(),personaKey=hash(JSON.stringify(readChoiceUserContext(c)));
    if(meta().modes?.[key]!=='narrative'||stored?.bodyHash!==hash(String(message.mes??'')))return null;
    if(!Array.isArray(stored.options)||stored.options.length!==4||stored.options[3]!==NARRATIVE_CONTINUE_LABEL
        ||!stored.options.every(option=>typeof option==='string'&&option.trim()&&option.length<=240))return null;
    const ready=stored.suggestionsGenerated===true&&stored.suggestionsVersion===2&&stored.language===language&&stored.personaKey===personaKey;
    return {index,key,language,personaKey,ready,options:ready?stored.options:[]};
}
function latestCallChoices(){
    if(!active()||!preferences().narrativeChoices||presetFlag(PROMPT_IDS.phone)!==true||choiceDispatch?.kind==='call-end')return null;
    const chat=ctx().chat??[],call=ongoingCallState();
    if(!call.active&&call.phase!=='incoming')return null;
    let index=chat.length-1;
    while(index>=0&&messageRole(chat[index])==='system')index--;
    const message=chat[index],record=message?.extra?.me35CallChoices;
    if(!message||messageRole(message)!=='character'||!String(message.mes??'').trim())return null;
    const valid=validCallChoiceRecord(message,index,record)&&record.sessionKey===call.sourceKey;
    const language=outputLanguage(),personaKey=hash(JSON.stringify(readChoiceUserContext(ctx())));
    const ready=valid&&record.suggestionsGenerated===true&&record.suggestionsVersion===2&&record.language===language&&record.personaKey===personaKey;
    return {kind:'call',index,key:messageKey(message,index),sessionKey:call.sourceKey,phase:call.phase,language,personaKey,ready,
        options:ready?record.options:[]};
}
function prepareChoiceDraft(textarea,payload,id,onCaptured=()=>{}){
    const draft=textarea.value;
    const originalReadOnly=textarea.readOnly;
    textarea.readOnly=true;
    textarea.value=payload;
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
    let finished=false,userEdited=false;
    const restore=()=>{
        if(finished)return;
        finished=true;textarea.removeEventListener('input',onInput);
        textarea.readOnly=originalReadOnly;
        if(id===identity()&&textarea.isConnected&&!userEdited&&(textarea.value===payload||textarea.value==='')){
            textarea.value=draft;
            textarea.dispatchEvent(new Event('input',{bubbles:true}));
        }
    };
    const onInput=event=>{
        if(event.isTrusted){userEdited=true;restore();return;}
        if(textarea.value===''){onCaptured();restore();return;}
        if(textarea.value!==payload){userEdited=true;restore();}
    };
    textarea.addEventListener('input',onInput);
    return restore;
}
function focusChoiceInput(){
    if(busy||choiceDispatch)return;
    revealDirectInput(document);
}
async function dispatchNarrativeChoice(index,key,choiceIndex){
    if(choiceDispatch||busy||document.body?.dataset.generating==='true')return;
    const state=latestNarrativeChoices();
    if(!state||state.index!==index||state.key!==key||choiceIndex<0||choiceIndex>3)return;
    const c=ctx(),textarea=document.querySelector('#send_textarea');
    if(typeof c.generate!=='function'||!(textarea instanceof HTMLTextAreaElement))return;
    const id=identity(),token={id,key};choiceDispatch=token;renderAll();
    const payload=choiceIndex===3?'':`[서사 선택] ${choiceSourceText(state.options[choiceIndex],state.language)}`;
    const restoreDraft=prepareChoiceDraft(textarea,payload,id);
    token.restoreDraft=restoreDraft;
    try{
        if(choiceIndex===3)await c.generate('normal',{automatic_trigger:true});
        else await c.generate('normal');
    }finally{
        restoreDraft();
        if(choiceDispatch===token)choiceDispatch=null;
        queueRender();sync();setTimeout(queueChoiceSuggestions,0);
    }
}
async function dispatchCallChoice(index,key,choiceIndex){
    if(choiceDispatch||busy||document.body?.dataset.generating==='true')return;
    const state=latestCallChoices();
    if(!state||state.index!==index||state.key!==key||choiceIndex<0||choiceIndex>3)return;
    const c=ctx(),textarea=document.querySelector('#send_textarea');
    if(typeof c.generate!=='function'||!(textarea instanceof HTMLTextAreaElement))return;
    const id=identity(),hangup=choiceIndex===3;
    const token={id,key,kind:hangup?'call-end':'call'};choiceDispatch=token;
    const restoreDraft=prepareChoiceDraft(textarea,hangup?'[통화 종료]':`[통화 선택] ${choiceSourceText(state.options[choiceIndex],state.language)}`,id);
    token.restoreDraft=restoreDraft;sync();renderAll();
    try{
        if(hangup){
            const data=meta(true);data.closedCalls??={};data.closedCalls[state.sessionKey]=true;
            await persist();
            renderAll();
            await c.generate('normal');
        }
        else await c.generate('normal');
    }finally{
        restoreDraft();
        if(choiceDispatch===token)choiceDispatch=null;
        queueRender();sync();setTimeout(queueChoiceSuggestions,0);
    }
}
function renderChoiceDock(state){
    bindViewport();
    const existing=document.querySelector('#me35-choice-dock');
    if(!state){existing?.remove();document.querySelector('#me35-choice-row')?.remove();return;}
    const host=choiceHost(document,state.index);
    const container=host?.chat;
    if(!container){existing?.remove();document.querySelector('#me35-choice-row')?.remove();return;}
    const isCall=state.kind==='call';
    const signature=`${state.kind??'narrative'}|${state.key}|${state.language}|${hash(JSON.stringify(state.options))}`;
    const disabled=busy||Boolean(choiceDispatch)||document.body?.dataset.generating==='true';
    const loading=Boolean(suggestionJob&&suggestionJob.id===identity()&&suggestionJob.key===state.key&&suggestionJob.epoch===suggestionEpoch);
    if(existing?.dataset.me35Signature===signature&&existing.closest('#chat')===container){
        for(const choice of existing.querySelectorAll('button'))choice.disabled=disabled;
        setChoiceRetryLoading(existing,loading,disabled||Boolean(suggestionJob));
        return;
    }
    const preservedScroll=existing?.dataset.me35ResponseKey===state.key&&existing.closest('#chat')===container?container.scrollTop:null;
    if(preservedScroll!==null)existing.parentElement.style.minHeight=`${existing.parentElement.getBoundingClientRect().height}px`;
    existing?.remove();
    const panel=el('section','','me35-choices');panel.id='me35-choice-dock';
    panel.dataset.me35Signature=signature;
    panel.dataset.me35ResponseKey=state.key;
    panel.setAttribute('role','group');panel.setAttribute('aria-label',isCall?'통화 응답 선택':'유저 행동 및 대사 선택');
    const heading=el('div','','me35-choices-heading');
    heading.append(el('div',isCall?'통화 응답 선택':'내 행동·대사 선택','me35-choices-title'));
    const actions=el('div','','me35-choices-actions');heading.append(actions);
    panel.append(heading);
    panel.append(el('small','선택하거나 직접 입력해 이어갈 수 있습니다.','me35-choices-hint'));
    if(state.ready){
        for(const [choiceIndex,option] of state.options.slice(0,3).entries()){
            const choice=el('button','','me35-choice');choice.type='button';choice.disabled=disabled;
            const choiceLabel=option;
            choice.append(el('span',String(choiceIndex+1),'me35-choice-number'),el('span',choiceLabel,'me35-choice-label'));
            choice.addEventListener('click',()=>Promise.resolve(isCall
                ?dispatchCallChoice(state.index,state.key,choiceIndex)
                :dispatchNarrativeChoice(state.index,state.key,choiceIndex)).catch(report));
            panel.append(choice);
        }
    }else{
        const pending=el('div','','me35-choice-pending-space');
        pending.setAttribute('aria-hidden','true');
        panel.append(pending);
    }
    const direct=button('직접 입력',focusChoiceInput);
    direct.classList.add('me35-choice','me35-choice-direct');direct.disabled=disabled;
    direct.replaceChildren(el('span','4','me35-choice-number'),el('span','직접 입력','me35-choice-label'));
    panel.append(direct);
    const retry=button('선택지 다시 생성',()=>{
        const current=latestCallChoices()??latestNarrativeChoices();
        if(!current||busy||choiceDispatch||suggestionJob)return;
        const kind=current.kind??'narrative';
        const requestKey=`${identity()}|${kind}|${current.key}|${current.language}${current.personaKey?`|${current.personaKey}`:''}`;
        suggestionRefreshes.add(requestKey);
        suggestionAttempts.delete(requestKey);
        queueChoiceSuggestions();
    });retry.classList.add('me35-choice-retry');retry.disabled=disabled;actions.append(retry);
    if(isCall){
        const hangup=button('통화 끊기',()=>dispatchCallChoice(state.index,state.key,3));
        hangup.classList.add('me35-choice-retry','me35-choice-hangup');hangup.disabled=disabled;
        hangup.setAttribute('aria-label','통화 모드를 종료하고 통화를 끊기');
        actions.append(hangup);
    }
    setChoiceRetryLoading(panel,loading,disabled||Boolean(suggestionJob));
    placeChoicePanel(panel,host,preservedScroll);
    updateViewportLayout();
}
function renderAll(){
    const c=ctx(),data=meta(),mode=readThoughtPromptMode();
    const usable=active();
    const choiceState=latestCallChoices()??latestNarrativeChoices();
    for(const stale of document.querySelectorAll('#chat .me35-choices:not(#me35-choice-dock)'))stale.remove();
    renderChoiceDock(choiceState);
    for(const block of document.querySelectorAll('#chat .mes[mesid]')){
        const index=Number(block.getAttribute('mesid')),message=c.chat[index];
        if(!message)continue;
        const key=messageKey(message,index),body=block.querySelector('.mes_text');
        if(!body)continue;
        if(messageRole(message)!=='character')continue;
        // Display-only repair also covers existing messages and older ST versions.
        if(usable){styleMessageTimestamps(body);repairThoughtBubbleLayout(body);normalizeShownTimestamp(body);initializeThoughtCards(thoughtCards(body));}
        if(!usable){
            for(const details of thoughtCards(body))details.hidden=false;
            for(const timestamp of body.querySelectorAll('[data-me35-hidden-timestamp]'))timestamp.removeAttribute('data-me35-hidden-timestamp');
            continue;
        }
        const narrative=data.modes?.[key]==='narrative'||(generation?.mode==='narrative'&&!generation.before.includes(key));
        for(const timestamp of timestampNodes(body)){
            if(narrative)timestamp.setAttribute('data-me35-hidden-timestamp','');
            else timestamp.removeAttribute('data-me35-hidden-timestamp');
        }
        // The bundled Regex owns the markup. The extension only controls visibility and opening.
        for(const details of thoughtCards(body)){
            if(mode==='always'||data.revealedThoughts?.[key]){details.hidden=false;}
            else details.hidden=mode==='moments'&&!data.importantThoughts?.[key];
        }
    }
}
function queueRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;renderAll();});}
function queueChoiceSuggestions(){
    if(suggestionJob||busy||choiceDispatch||document.body?.dataset.generating==='true')return;
    const state=latestCallChoices()??latestNarrativeChoices(),c=ctx();
    if(!state||typeof c.generateRaw!=='function')return;
    const previous=state.kind==='call'?c.chat[state.index]?.extra?.me35CallChoices:c.chat[state.index]?.extra?.me35Choices;
    const kind=state.kind??'narrative',language=state.language??outputLanguage();
    const id=identity(),attempt=`${id}|${kind}|${state.key}|${language}${state.personaKey?`|${state.personaKey}`:''}`;
    if(previous?.suggestionsGenerated&&previous.suggestionsVersion===2&&previous.language===language&&previous.personaKey===state.personaKey&&!suggestionRefreshes.has(attempt)
        &&(kind!=='call'||(validCallChoiceRecord(c.chat[state.index],state.index,previous)&&previous.sessionKey===state.sessionKey)))return;
    const attempts=suggestionAttempts.get(attempt)??0;
    if(attempts>=2){suggestionRefreshes.delete(attempt);return;}
    suggestionAttempts.set(attempt,attempts+1);
    if(suggestionAttempts.size>200)suggestionAttempts.delete(suggestionAttempts.keys().next().value);
    const token={id,key:state.key,epoch:suggestionEpoch};suggestionJob=token;queueRender();
    const request=buildChoiceSuggestionPrompt(c.chat??[],kind,c.name2,language,readChoiceUserContext(c));
    Promise.resolve().then(()=>c.generateRaw(request)).then(async result=>{
        const latest=latestCallChoices()??latestNarrativeChoices();
        if(token.epoch!==suggestionEpoch||id!==identity()||busy||!latest||latest.key!==state.key||latest.language!==language||latest.personaKey!==state.personaKey||(latest.kind??'narrative')!==kind){suggestionAttempts.delete(attempt);return;}
        const generated=parseGeneratedChoiceSuggestions(result,kind,language);
        if(generated.length!==3)return;
        const message=ctx().chat[state.index];
        // Existing chats may predate choice metadata. Rebuild only extension metadata.
        if(kind==='call'&&(!validCallChoiceRecord(message,state.index,message.extra?.me35CallChoices)||message.extra.me35CallChoices.sessionKey!==latest.sessionKey)){
            message.extra??={};
            message.extra.me35CallChoices={bodyHash:hash(String(message.mes??'')),sourceKey:state.key,sessionKey:latest.sessionKey,phase:latest.phase,language,options:latest.options};
        }
        const record=kind==='call'?message.extra?.me35CallChoices:message.extra?.me35Choices;
        if(!record||record.bodyHash!==hash(String(message.mes??'')))return;
        record.options=[...generated,kind==='call'?CALL_END_LABEL:NARRATIVE_CONTINUE_LABEL];
        record.language=language;
        record.personaKey=state.personaKey;
        record.suggestionsVersion=2;
        record.suggestionsGenerated=true;
        suggestionRefreshes.delete(attempt);
        if(Number.isInteger(message.swipe_id)&&message.swipe_info?.[message.swipe_id])message.swipe_info[message.swipe_id].extra=structuredClone(message.extra);
        // Only metadata and the separate dock change. Never redraw the reply/iframe.
        await ctx().saveChat?.();queueRender();
    }).catch(report).finally(()=>{
        if(suggestionJob===token){suggestionJob=null;queueRender();setTimeout(queueChoiceSuggestions,1200);}
    });
}
function watchThoughtRender(){
    const root=document.querySelector('#chat');
    if(!root||root===thoughtRoot)return;
    thoughtObserver?.disconnect();
    thoughtRoot=root;
    thoughtObserver=new MutationObserver(()=>{queueRender();if(loadingWait)renderLoading();});
    thoughtObserver.observe(root,{childList:true,subtree:true});
    renderLoading();
}
async function init(){
    bindViewport=watchViewportLayout(document,window);
    watchBackgroundControls(document);
    try{({promptManager}=await import('/scripts/openai.js'));}catch(error){report(error);}
    const c=ctx();
    if(!c?.eventSource||!c.setExtensionPrompt||!c.saveMetadata){console.error('[Messenger35] Supported SillyTavern context API not found.');return;}
    preferences();
    const received=c.eventTypes.MESSAGE_RECEIVED;
    if(received){
        const normalizeReceipt=index=>{
            if(!active())return;
            const message=ctx().chat?.[index];
            if(!message||messageRole(message)!=='character')return;
            const body=normalizeThoughtSpacing(message.mes);
            if(body===message.mes)return;
            message.mes=body;
            if(Number.isInteger(message.swipe_id)&&Array.isArray(message.swipes))message.swipes[message.swipe_id]=body;
        };
        if(typeof c.eventSource.makeFirst==='function')c.eventSource.makeFirst(received,normalizeReceipt);
        else c.eventSource.on(received,normalizeReceipt);
    }
    registerLayoutHooks();
    const repositionLoading=()=>{if(loadingWait)renderLoading();};
    window.addEventListener('resize',repositionLoading);
    window.addEventListener('scroll',repositionLoading,true);
    window.visualViewport?.addEventListener('resize',repositionLoading);
    window.visualViewport?.addEventListener('scroll',repositionLoading);
    const on=(name,handler)=>{const event=c.eventTypes[name];if(event)c.eventSource.on(event,(...args)=>Promise.resolve().then(()=>handler(...args)).catch(report));};
    on('APP_READY',()=>{watchMenu();watchThoughtRender();sync();void syncPreset().catch(report);});
    on('CHAT_CHANGED',()=>{suggestionEpoch++;suggestionAttempts.clear();suggestionRefreshes.clear();finishDialog(null);closeSettings();generation=null;busy=false;choiceDispatch?.restoreDraft?.();choiceDispatch=null;stopLoading();watchMenu();watchThoughtRender();sync();renderAll();setTimeout(queueChoiceSuggestions,0);void syncPreset().catch(report);});
    on('GENERATION_STARTED',async(type,options,dryRun)=>{
        if(!dryRun&&!['quiet','impersonate'].includes(type))await maybeShowTimeNotice();
        generation={id:identity(),type,dryRun,mode:derive(effectiveMeta(),ctx().chat??[]).mode,timeMode:readTimePromptMode(),before:(ctx().chat??[]).map(messageKey)};
        sync();
    });
    on('GENERATION_AFTER_COMMANDS',async(type,options,dryRun)=>{
        if(dryRun||['quiet','impersonate'].includes(type)){stopLoading();sync();return;}
        if(!active()){generation=null;stopLoading();sync();return;}
        await maybeShowTimeNotice();
        const id=identity();await syncPreset();if(id!==identity())return;
        if(!activeDialog?.dialog.matches('.me35-time-dialog,.me35-preset-warning'))finishDialog(null);
        busy=true;
        generation={id,type,dryRun,mode:generation?.id===id?generation.mode:derive(effectiveMeta(),ctx().chat).mode,timeMode:generation?.id===id?generation.timeMode:readTimePromptMode(),before:generation?.id===id?generation.before:ctx().chat.map(messageKey)};
        if(!loadingWait)startLoading();
        sync();queueRender();
    });
    on('CHAT_COMPLETION_PROMPT_READY',event=>{
        if(event.chat?.some(message=>typeof message.content==='string'&&message.content.includes('[ME35_CHOICE_REQUEST]')))return;
        if(!active()||event.dryRun||generation?.dryRun||!generation||generation.id!==identity()
            ||['quiet','impersonate'].includes(generation.type)||!Array.isArray(event.chat))return;
        const c=ctx();
        ensureCallClock();
        refreshRequestState(event.chat,effectiveMeta(),c.chat??[],{
            type:generation.type,character:c.name2,user:c.name1,
        });
    });
    on('GENERATION_ENDED',async()=>{
        busy=false;stopLoading();sync();
        const completed=generation;generation=null;
        if(completed?.id===identity()){
            const pending=ctx().chat.map(messageKey).map((key,index)=>({key,index})).filter(item=>!completed.before.includes(item.key));
            for(const {key,index} of pending){
                if(completed.id!==identity()||busy)break;
                if(currentKey(index)===key)await processMessage(index,completed.mode,completed.timeMode);
            }
        }
        queueRender();setTimeout(queueChoiceSuggestions,0);
    });
    on('GENERATION_STOPPED',()=>{busy=false;generation=null;choiceDispatch?.restoreDraft?.();choiceDispatch=null;stopLoading();sync();queueRender();});
    for(const name of ['GENERATION_ERROR','GENERATION_FAILED','GENERATION_INTERRUPTED'])on(name,()=>{busy=false;generation=null;choiceDispatch?.restoreDraft?.();choiceDispatch=null;stopLoading();sync();queueRender();});
    for(const name of ['CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED','MESSAGE_UPDATED'])on(name,queueRender);
    for(const name of ['MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED'])on(name,async()=>{finishDialog(null);await reconcileScenarioClock();sync();queueRender();});
    on('SETTINGS_UPDATED',()=>{watchMenu();sync();queueRender();setTimeout(queueChoiceSuggestions,0);void syncPreset().then(sync).catch(report);});
    for(const name of ['PRESET_CHANGED','MAIN_API_CHANGED'])on(name,()=>{suggestionEpoch++;suggestionAttempts.clear();suggestionRefreshes.clear();sync();queueRender();setTimeout(queueChoiceSuggestions,0);void syncPreset().then(sync).catch(report);});
    document.addEventListener('change',()=>requestAnimationFrame(()=>syncPreset().then(()=>{queueRender();setTimeout(queueChoiceSuggestions,0);}).catch(report)),true);
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watchMenu,{once:true});
    else{watchMenu();watchThoughtRender();}
    sync();renderAll();setTimeout(queueChoiceSuggestions,0);
}
init().catch(report);
