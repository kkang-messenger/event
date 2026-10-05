// Visual viewport accounts for mobile browser bars, keyboards, split view and zoom.
export function viewportBox(win){
    const v=win.visualViewport;
    return {left:v?.offsetLeft??0,top:v?.offsetTop??0,width:Math.max(1,v?.width??win.innerWidth),height:Math.max(1,v?.height??win.innerHeight)};
}
export function updateViewportLayout(doc=document,win=window){
    const v=viewportBox(win),root=doc.documentElement;
    root.style.setProperty('--me35-viewport-width',`${v.width}px`);
    root.style.setProperty('--me35-viewport-height',`${v.height}px`);
    root.style.setProperty('--me35-viewport-center-x',`${v.left+v.width/2}px`);
    root.style.setProperty('--me35-viewport-center-y',`${v.top+v.height/2}px`);

}
export function watchViewportLayout(doc=document,win=window){
    let queued=false,anchor=null;
    const update=()=>{if(queued)return;queued=true;win.requestAnimationFrame(()=>{queued=false;updateViewportLayout(doc,win);});};
    const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(update):null;
    const bind=()=>{const form=doc.querySelector('#send_form');if(form!==anchor){observer?.disconnect();anchor=form;if(form)observer?.observe(form);}update();};
    for(const event of ['resize','orientationchange','scroll'])win.addEventListener(event,update,{passive:true});
    win.visualViewport?.addEventListener('resize',update,{passive:true});
    win.visualViewport?.addEventListener('scroll',update,{passive:true});
    bind();return bind;
}
