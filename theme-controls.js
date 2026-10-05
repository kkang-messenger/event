// Keep the theme's dependent controls in sync with the actual dropdown value.
// This presentation repair also runs when Messenger features are switched OFF.
const fieldNames=['me35BgFit','me35BgWidth','me35BgX','me35BgY'];
const previousDisplay=new WeakMap();
const installed=new WeakSet();
function fieldId(node){
    return node?.getAttribute?.('data-var-id')??(node?.id?.startsWith('cts-')?node.id.slice(4):null);
}
function findControls(doc,id){
    return [...doc.querySelectorAll(`[data-var-id="${id}"],#cts-${id}`)];
}
function labeledRow(control,id){
    // The installed CTSI extension renders every setting as a direct child of
    // #cts-row-1 or #cts-row-2. Prefer that exact card so its label and inputs
    // are hidden together, regardless of the inner slider wrappers.
    const card=control.closest?.('#ctsi-drawer-content #cts-row-1 > div, #ctsi-drawer-content #cts-row-2 > div');
    if(card)return card;
    for(let row=control.parentElement;row&&row!==control.ownerDocument.body;row=row.parentElement){
        if(!['DIV','LABEL'].includes(row.tagName))continue;
        const hasLabel=row.tagName==='LABEL'||[...row.children].some(child=>child.tagName==='SPAN');
        if(!hasLabel)continue;
        const fields=[...row.querySelectorAll('input,select,textarea,toolcool-color-picker')];
        // Never hide a whole settings group that also contains other fields.
        if(fields.some(field=>fieldId(field)!==id))return null;
        return row;
    }
    return null;
}
function setHidden(row,hidden){
    if(hidden){
        if(!previousDisplay.has(row))previousDisplay.set(row,{value:row.style.getPropertyValue('display'),priority:row.style.getPropertyPriority('display')});
        if(row.style.getPropertyValue('display')!=='none'||row.style.getPropertyPriority('display')!=='important')row.style.setProperty('display','none','important');
    }else if(previousDisplay.has(row)){
        const saved=previousDisplay.get(row);previousDisplay.delete(row);
        if(saved.value)row.style.setProperty('display',saved.value,saved.priority);
        else row.style.removeProperty('display');
    }
}
export function syncBackgroundControls(doc=document){
    const toggle=findControls(doc,'me35BackgroundImage').find(node=>node.tagName==='SELECT');
    if(!toggle)return;
    const enabled=toggle.value==='on';
    const fit=findControls(doc,'me35BgFit').find(node=>node.tagName==='SELECT')?.value;
    doc.documentElement.dataset.me35BackgroundControls=enabled?'on':'off';
    doc.documentElement.dataset.me35BackgroundFit=fit??'contain';
    for(const id of fieldNames){
        const hidden=!enabled||(id==='me35BgWidth'&&fit!=='custom');
        const rows=new Set(findControls(doc,id).map(control=>labeledRow(control,id)).filter(Boolean));
        for(const row of rows)setHidden(row,hidden);
    }
}
export function watchBackgroundControls(doc=document){
    if(installed.has(doc))return;
    installed.add(doc);
    const sync=()=>syncBackgroundControls(doc);
    const changed=event=>{
        if(['me35BackgroundImage','me35BgFit'].includes(fieldId(event.target)))sync();
    };
    doc.addEventListener('change',changed,true);
    doc.addEventListener('input',changed,true);
    const observe=()=>{
        sync();
        const Observer=doc.defaultView?.MutationObserver;
        if(!doc.body||!Observer)return;
        // CTSI rebuilds its option rows after importing/changing a theme.
        new Observer(sync).observe(doc.body,{childList:true,subtree:true});
    };
    if(doc.body)observe();
    else doc.addEventListener('DOMContentLoaded',observe,{once:true});
}
