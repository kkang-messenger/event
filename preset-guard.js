// Match stable prompt identifiers, not an editable preset filename or enabled toggles.
export function classifyMessengerPreset(settings,order,requiredIds){
    if(!settings||!Array.isArray(settings.prompts)||!Array.isArray(order))return 'unknown';
    const definitions=new Set(settings.prompts.map(p=>p.identifier));
    const ordered=new Set(order.map(p=>p.identifier));
    return requiredIds.every(id=>definitions.has(id)&&ordered.has(id))?'compatible':'incompatible';
}

export function createPresetGuard({snapshot,canShow,show,disable,close,schedule=setTimeout,cancel=clearTimeout,onError=console.error}){
    let timer=null,pending=false,notified=false,epoch=0;
    const incompatible=()=>{const s=snapshot();return s.enabled&&s.kind==='incompatible';};
    function check(){
        if(!incompatible()){
            if(timer!==null){cancel(timer);timer=null;}
            notified=false;epoch++;
            if(pending)close();
            return;
        }
        if(pending||notified||timer!==null)return;
        timer=schedule(run,250);
    }
    async function run(){
        timer=null;
        if(!incompatible()){check();return;}
        if(!canShow()){timer=schedule(run,500);return;}
        const current=epoch;pending=true;notified=true;
        try{
            const accepted=await show();
            if(accepted===true&&current===epoch&&incompatible())await disable();
        }catch(error){onError(error);}
        finally{pending=false;check();}
    }
    return {check};
}
