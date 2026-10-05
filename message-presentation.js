// Recognize a timestamp by both its semantic class and its complete clock text.
export function hasTimestampClass(value){
    return String(value??'').replace(/([a-z])([A-Z])/g,'$1-$2').split(/\s+/u).some(token=>/(?:timestamp|(?:^|[-_])(?:time|clock)(?:$|[-_]))/i.test(token));
}
export function isClockText(value){
    return /^(?:(?:\d{1,4}[./-])?\d{1,2}[./-]\d{1,2},?\s+)?(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(String(value??'').trim());
}
function classValue(tag){
    const m=tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return m?m[1]??m[2]??m[3]:'';
}
export function normalizeTimestampMarkup(text){
    // The caller separates fenced/HTML/script blocks. Standalone phone screens are also excluded.
    if(/\bphone-frame\b/i.test(text))return text;
    return text.replace(/<(div|span|time)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,(whole,tag,attrs,body)=>{
        if(!hasTimestampClass(classValue(attrs))||!isClockText(body.replace(/<[^>]*>/g,'')))return whole;
        if(classValue(attrs).split(/\s+/u).includes('chat-timestamp'))return whole;
        const updated=attrs.replace(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,(_,a,b,c)=>`class="${a??b??c} chat-timestamp"`);
        return `<${tag}${updated}>${body}</${tag}>`;
    });
}
export function timestampNodes(root){
    const candidates=[...root.querySelectorAll('[class],time')].filter(node=>
        (node.localName==='time'||hasTimestampClass(node.className))&&isClockText(node.textContent)
        &&!node.closest('pre,code,iframe,.TH-render,.phone-frame,messenger_thinking,custom-messenger_thinking')
        );
    return candidates.filter(node=>!candidates.some(other=>other!==node&&other.contains(node)));
}
function setStyle(node,name,value){
    if(node.style.getPropertyValue(name)!==value||node.style.getPropertyPriority(name)!=='important')node.style.setProperty(name,value,'important');
}
export function styleMessageTimestamps(root){
    const nodes=timestampNodes(root);
    for(const node of nodes){
        if(!node.hasAttribute('data-me35-clock'))node.setAttribute('data-me35-clock','');
        if(!node.classList.contains('chat-timestamp'))node.classList.add('chat-timestamp');
        const view=node.ownerDocument.defaultView;
        const palette=view?.getComputedStyle(node).getPropertyValue('--bubbleColorScheme').trim().replace(/^['"]|['"]$/g,'');
        const doc=node.ownerDocument;
        const dark=palette==='kakaotalk'||(!palette&&[doc.documentElement,doc.body].some(e=>/--bubbleColorScheme\s*:\s*kakaotalk(?:\s*;|\s*$)/i.test(e?.getAttribute('style')??'')));
        for(const element of [node,...node.querySelectorAll('*')]){
            setStyle(element,'font-size','12px');setStyle(element,'line-height','1');
            setStyle(element,'-webkit-text-size-adjust','100%');setStyle(element,'text-size-adjust','100%');
        }
        setStyle(node,'opacity',dark?'1':'0.5');
        setStyle(node,'color',dark?'#D8DCE2':'var(--name-color,#636B76)');
        setStyle(node,'-webkit-text-fill-color',dark?'#D8DCE2':'var(--name-color,#636B76)');
        for(const child of node.querySelectorAll('*')){
            setStyle(child,'opacity','1');setStyle(child,'color','inherit');setStyle(child,'-webkit-text-fill-color','inherit');
        }
    }
    return nodes;
}
const initializedThoughts=new WeakSet();
export function initializeThoughtCards(cards){
    for(const details of cards){
        if(initializedThoughts.has(details))continue;
        initializedThoughts.add(details);
        details.open=false;details.removeAttribute('open');
    }
}

export function prepareRawThoughtCards(root){
    for(const raw of root?.querySelectorAll('messenger_thinking,custom-messenger_thinking')??[]){
        if(raw.closest('pre,code,.phone-frame,.TH-render,details'))continue;
        const doc=raw.ownerDocument,details=doc.createElement('details'),summary=doc.createElement('summary');
        details.className='me35-thought';summary.textContent='속마음 보기';details.append(summary);
        while(raw.firstChild)details.append(raw.firstChild);
        raw.replaceWith(details);
    }
}
