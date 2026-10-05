import {hasTimestampClass} from './message-presentation.js?v=3.5.57';
import {messageKey,messageRole,validScenarioTime} from './core.js';

const htmlTag=/<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;
function hasClass(tag,name){
    const match=tag.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return Boolean(match&&String(match[1]??match[2]??match[3]).split(/\s+/u).includes(name));
}
function withoutFencedCode(raw){
    let fence=null;
    return raw.split(/(?<=\n)/u).map(line=>{
        const mark=line.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/u);
        if(fence){
            if(mark&&mark[1][0]===fence.char&&mark[1].length>=fence.length&&!mark[2].trim())fence=null;
            return '\n';
        }
        if(mark){fence={char:mark[1][0],length:mark[1].length};return '\n';}
        return line;
    }).join('');
}
function withoutPhoneFrames(raw){
    // The phone's clock belongs to its HTML screen, not the scenario timeline.
    let text=raw.replace(/<html\b[^>]*>[\s\S]*?(?:<\/html\s*>|$)/gi,block=>/\bphone-frame\b/i.test(block)?' ':block);
    let result='',copied=0,skip=null;
    for(const match of text.matchAll(htmlTag)){
        const tag=match[0],closing=/^<\//u.test(tag),name=tag.match(/^<\/?([a-z][\w:-]*)/i)?.[1].toLowerCase();
        if(!skip&&!closing&&hasClass(tag,'phone-frame')){
            result+=text.slice(copied,match.index);skip={name,depth:1};
            if(/\/\s*>$/u.test(tag)){copied=match.index+tag.length;skip=null;}
            continue;
        }
        if(skip&&name===skip.name){
            if(closing)skip.depth--;
            else if(!/\/\s*>$/u.test(tag))skip.depth++;
            if(skip.depth===0){copied=match.index+tag.length;skip=null;}
        }
    }
    return result+(skip?'':text.slice(copied));
}
function timestampText(body){
    return body.replace(/<[^>]*>/g,'').replace(/&#(?:0*58|x0*3a);|&colon;/gi,':')
        .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi,' ').trim();
}
function normalizeTimestamp(value){
    // Older replies can contain a date prefix; only HH:mm becomes the clock.
    const match=value.match(/^(?:\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,2})?\s*,?\s+)?(\d{1,2})\s*:\s*(\d{2})$/u);
    if(!match)return null;
    const time=`${match[1].padStart(2,'0')}:${match[2]}`;
    return validScenarioTime(time)?time:null;
}
export function extractScenarioTimestamp(raw){
    let text=withoutFencedCode(String(raw??''));
    text=text.replace(/<!--[\s\S]*?(?:-->|$)/g,' ')
        .replace(/<messenger_thinking\b[^>]*>[\s\S]*?(?:<\/messenger_thinking\s*>|$)/gi,' ')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
    text=withoutPhoneFrames(text);
    let latest=null,candidate=null;
    for(const match of text.matchAll(htmlTag)){
        const tag=match[0];
        if(!/^<\/?div(?:\s|>)/i.test(tag))continue;
        if(/^<\//u.test(tag)){
            if(candidate&&--candidate.depth===0){
                const time=normalizeTimestamp(timestampText(text.slice(candidate.start,match.index)));
                if(time)latest=time;
                candidate=null;
            }
        }else if(candidate){
            if(!/\/\s*>$/u.test(tag))candidate.depth++;
        }else if(hasTimestampClass(tag.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(value=>value!==undefined))&&!/\/\s*>$/u.test(tag)){
            candidate={start:match.index+tag.length,depth:1};
        }
    }
    return latest;
}
export function createScenarioClock(startIndex=0){
    return {startIndex:Number.isInteger(startIndex)&&startIndex>=0?startIndex:0,observations:{}};
}
export function advanceScenarioTime(value,minutes=1){
    if(!validScenarioTime(value)||!Number.isFinite(minutes))return null;
    const [hour,minute]=value.split(':').map(Number);
    const total=((hour*60+minute+Math.trunc(minutes))%1440+1440)%1440;
    return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}
export function randomScenarioTime(random=Math.random){
    const sample=Number(random());
    const minute=Math.floor(Math.min(0.999999999,Math.max(0,Number.isFinite(sample)?sample:0))*1440);
    return `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
}
export function recordScenarioTimestamp(clock,chat,index){
    const state=clock??createScenarioClock();
    if(!Number.isInteger(index)||index<(state.startIndex??0)||!chat?.[index]||messageRole(chat[index])!=='character')return state;
    const time=extractScenarioTimestamp(chat[index].mes);
    if(!time)return state;
    const source=messageKey(chat[index],index);
    if(state.observations?.[source]===time)return state;
    return {...state,observations:{...state.observations,[source]:time}};
}
export function resolveScenarioTime(meta,chat){
    const clock=meta?.scenarioClock;
    let latestObservationIndex=-1,latestObservation=null;
    if(clock?.observations){
        for(let i=(chat?.length??0)-1;i>=(clock.startIndex??0);i--){
            if(messageRole(chat[i])!=='character')continue;
            const time=clock.observations[messageKey(chat[i],i)];
            if(validScenarioTime(time)){latestObservationIndex=i;latestObservation=time;break;}
        }
    }
    const callClock=meta?.callClock;
    if(validScenarioTime(callClock?.time)&&typeof callClock.lastKey==='string'){
        const callIndex=(chat??[]).findIndex((message,index)=>messageRole(message)==='character'&&messageKey(message,index)===callClock.lastKey);
        if(callIndex>latestObservationIndex)return callClock.time;
    }
    if(latestObservation)return latestObservation;
    return validScenarioTime(meta?.scenarioTime)?meta.scenarioTime:null;
}
