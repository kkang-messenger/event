// Choices belong to the same scrollable conversation as the response they follow.
export function choiceHost(doc,index){
    const chat=doc.querySelector('#chat');
    const message=chat?.querySelector(`.mes[mesid="${Number(index)}"]`);
    return message&&chat.contains(message)?{chat,message}:null;
}
export function placeChoicePanel(panel,host,preservedScroll=null){
    const {chat,message}=host;
    const follow=chat.scrollHeight-chat.clientHeight-chat.scrollTop<80;
    let row=chat.querySelector('#me35-choice-row');
    if(!row){row=chat.ownerDocument.createElement('div');row.id='me35-choice-row';}
    if(preservedScroll===null)row.style.removeProperty('min-height');
    row.replaceChildren(panel);
    message.after(row);
    if(preservedScroll!==null){chat.scrollTop=preservedScroll;return;}
    if(!follow)return;
    const bounds=chat.getBoundingClientRect(),reply=message.getBoundingClientRect(),choices=panel.getBoundingClientRect();
    // Keep the entire last response visible when it fits. Longer responses stay
    // readable from their beginning, with choices below in the same scroll flow.
    const target=choices.bottom-reply.top<=chat.clientHeight
        ?choices.bottom-bounds.bottom:reply.top-bounds.top;
    chat.scrollTop+=target;
}
const cleanups=new WeakMap();
export function setChoiceRetryLoading(panel,loading,disabled=false){
    const button=panel.querySelector('.me35-choice-retry');
    if(!button)return;
    button.disabled=disabled||loading;
    button.setAttribute('aria-busy',String(loading));
    if(button.dataset.loading===String(loading))return;
    button.dataset.loading=String(loading);
    button.replaceChildren();
    if(loading){
        const spinner=panel.ownerDocument.createElement('span');
        spinner.className='me35-choice-spinner';spinner.setAttribute('aria-hidden','true');
        button.append(spinner);
    }
    button.append(panel.ownerDocument.createTextNode(loading?'선택지 생성 중…':'선택지 다시 생성'));
}
export function revealDirectInput(doc=document){
    const textarea=doc.querySelector('#send_textarea');
    if(!textarea||textarea.tagName!=='TEXTAREA')return;
    cleanups.get(textarea)?.();
    doc.querySelectorAll('.me35-direct-input-hint').forEach(node=>node.remove());
    textarea.classList.add('me35-direct-input-active');
    const cleanup=()=>{textarea.classList.remove('me35-direct-input-active');textarea.removeEventListener('input',cleanup);textarea.removeEventListener('blur',cleanup);cleanups.delete(textarea);};
    cleanups.set(textarea,cleanup);
    textarea.addEventListener('input',cleanup,{once:true});
    textarea.addEventListener('blur',cleanup,{once:true});
    textarea.focus({preventScroll:true});
    textarea.setSelectionRange(textarea.value.length,textarea.value.length);
    textarea.scrollIntoView?.({block:'nearest',behavior:'smooth'});
}
