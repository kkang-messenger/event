const QUOTE_PAIRS=[
    ['“','”'],['‘','’'],['„','“'],['‚','‘'],['‟','”'],['‛','’'],
    ['「','」'],['『','』'],['｢','｣'],['〝','〟'],['﹁','﹂'],['﹃','﹄'],
    ['«','»'],['‹','›'],['《','》'],['〈','〉'],
    ['[',']'],['［','］'],['【','】'],['〔','〕'],['〖','〗'],['〘','〙'],['〚','〛'],
    ['(',')'],['（','）'],['{','}'],['｛','｝'],
];
const EXCLUDED='script,style,pre,code,textarea,input,select,option,button,svg,math,mark,[contenteditable="true"],.me35-text-highlight';
const WORD=/[A-Za-z0-9\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

function escapePattern(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function escapedAt(text,index){
    let slashes=0;
    for(let i=index-1;i>=0&&text[i]==='\\';i--)slashes++;
    return slashes%2===1;
}
function sameQuoteRanges(text,quote,apostrophe=false){
    const ranges=[];let opening=-1;
    for(let i=0;i<text.length;i++){
        if(text[i]==='\n'||text[i]==='\r'){opening=-1;continue;}
        if(text[i]!==quote||escapedAt(text,i))continue;
        if(opening<0){
            if(apostrophe&&WORD.test(text[i-1]??''))continue;
            opening=i;continue;
        }
        if(apostrophe&&WORD.test(text[i-1]??'')&&WORD.test(text[i+1]??''))continue;
        if(i-opening>1)ranges.push([opening,i+1]);
        opening=-1;
    }
    return ranges;
}
function rangesIn(text){
    const ranges=[];
    for(const [open,close] of QUOTE_PAIRS){
        const body=`(?:(?!${escapePattern(close)})[^\\r\\n]){1,800}?`;
        const pattern=new RegExp(`${escapePattern(open)}${body}${escapePattern(close)}`,'gu');
        for(const match of text.matchAll(pattern))ranges.push([match.index,match.index+match[0].length]);
    }
    ranges.push(...sameQuoteRanges(text,'"'),...sameQuoteRanges(text,'＂'),...sameQuoteRanges(text,"'",true));
    ranges.sort((a,b)=>a[0]-b[0]||(b[1]-b[0])-(a[1]-a[0]));
    const result=[];let end=-1;
    for(const [start,stop] of ranges){
        if(start<end)continue;
        result.push([start,stop]);end=stop;
    }
    return result;
}
function unwrap(root){
    for(const mark of root.querySelectorAll('.me35-text-highlight')){
        const parent=mark.parentNode;
        if(!parent)continue;
        while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);
        parent.removeChild(mark);
    }
}
export function highlightMessageText(root,enabled=true){
    if(!root?.ownerDocument)return;
    if(!enabled){unwrap(root);return;}
    const doc=root.ownerDocument,filter=doc.defaultView?.NodeFilter;
    const walker=doc.createTreeWalker(root,filter?.SHOW_TEXT??4,{
        acceptNode(node){
            if(!node.data||!node.data.trim()||node.parentElement?.closest(EXCLUDED))return filter?.FILTER_REJECT??2;
            return filter?.FILTER_ACCEPT??1;
        },
    });
    const nodes=[];
    while(walker.nextNode())nodes.push(walker.currentNode);
    for(const node of nodes){
        if(!node.parentNode)continue;
        const ranges=rangesIn(node.data);
        if(!ranges.length)continue;
        const text=node.data,fragment=doc.createDocumentFragment();let cursor=0;
        for(const [start,end] of ranges){
            if(start>cursor)fragment.append(doc.createTextNode(text.slice(cursor,start)));
            const mark=doc.createElement('span');
            mark.className='me35-text-highlight';
            mark.textContent=text.slice(start,end);
            fragment.append(mark);cursor=end;
        }
        if(cursor<text.length)fragment.append(doc.createTextNode(text.slice(cursor)));
        node.parentNode.replaceChild(fragment,node);
    }
}
export {rangesIn as quotedTextRanges};
