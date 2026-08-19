/**
 * Self-contained HTML for the PDF measurement WebView.
 *
 * Uses PDF.js 3.11.174 bundled with the mobile app. The caller provides
 * static asset URLs for the library and worker so this viewer never needs a
 * network request to render an imported plan.
 * Renders the PDF on one canvas, with a transparent overlay canvas that
 * captures tap/click events for placing measurement points.
 *
 * Communicates with React Native via:
 *   INBOUND  (RN → WebView): window.postMessage(JSON.stringify(msg))
 *   OUTBOUND (WebView → RN): ReactNativeWebView.postMessage(JSON.stringify(msg))
 *
 * Message types:
 *   INBOUND:
 *     { type: 'loadPdf', base64: string }
 *     { type: 'setMode', mode: 'none'|'distance'|'area' }
 *     { type: 'clearCurrentPoints' }
 *     { type: 'undoPoint' }
 *     { type: 'setSavedMeasurements', measurements: [{id,type,points,label}] }
 *     { type: 'setPage', page: number }
 *     { type: 'finishArea' }
 *   OUTBOUND:
 *     { type: 'ready' }
 *     { type: 'pdfLoaded', pages: number }
 *     { type: 'pageRendered', page, width, height, totalPages }
 *     { type: 'pointAdded', x, y, count, width, height }
 *     { type: 'measurementComplete', mode, points, width, height }
 *     { type: 'error', message: string }
 */
export function createViewerHtml(pdfJsUri: string, pdfJsWorkerUri: string) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; overflow:hidden; background:#1D2530; touch-action:pan-y; }
    #wrapper { width:100%; height:100%; overflow-y:auto; overflow-x:hidden; display:flex; align-items:flex-start; justify-content:center; }
    #canvasContainer { position:relative; flex-shrink:0; }
    #pdfCanvas { display:block; }
    #overlayCanvas { position:absolute; top:0; left:0; touch-action:none; }
    #loading { position:fixed; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#1D2530; color:#FF9F1A; font-family:-apple-system,'Helvetica Neue',sans-serif; font-size:14px; gap:14px; z-index:10; }
    .spinner { width:30px; height:30px; border:3px solid rgba(255,159,26,0.25); border-top-color:#FF9F1A; border-radius:50%; animation:spin 0.8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
  </style>
</head>
<body>
  <div id="loading"><div class="spinner"></div><span>Loading PDF viewer...</span></div>
  <div id="wrapper" style="display:none">
    <div id="canvasContainer">
      <canvas id="pdfCanvas"></canvas>
      <canvas id="overlayCanvas"></canvas>
    </div>
  </div>
  <script src="${pdfJsUri}"></script>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc=${JSON.stringify(pdfJsWorkerUri)};
    var pdfDoc=null, currentPage=1, mode='none', currentPoints=[], savedMeasurements=[], canvasW=0, canvasH=0, naturalPageW=0, lastTap=0;
    var pdfCanvas=document.getElementById('pdfCanvas'), overlayCanvas=document.getElementById('overlayCanvas');
    var pdfCtx=pdfCanvas.getContext('2d'), overlayCtx=overlayCanvas.getContext('2d');
    var loadingEl=document.getElementById('loading'), wrapperEl=document.getElementById('wrapper');

    function postRN(data) {
      var s=JSON.stringify(data);
      if(window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(s); }
      else { try{window.parent.postMessage(s,'*');}catch(e){} }
    }

    async function renderPage(n) {
      if(!pdfDoc) return;
      showLoading('Rendering page '+n+'...');
      var page=await pdfDoc.getPage(n);
      var natural=page.getViewport({scale:1});
      naturalPageW=natural.width;
      var scale=window.innerWidth/natural.width;
      var vp=page.getViewport({scale:scale});
      pdfCanvas.width=vp.width; pdfCanvas.height=vp.height;
      overlayCanvas.width=vp.width; overlayCanvas.height=vp.height;
      overlayCanvas.style.width=vp.width+'px'; overlayCanvas.style.height=vp.height+'px';
      canvasW=vp.width; canvasH=vp.height;
      await page.render({canvasContext:pdfCtx,viewport:vp}).promise;
      hideLoading();
      drawOverlay();
      postRN({type:'pageRendered',page:n,width:canvasW,height:canvasH,totalPages:pdfDoc.numPages,naturalPageW:naturalPageW});
    }

    function showLoading(msg) { loadingEl.querySelector('span').textContent=msg||'Loading...'; loadingEl.style.display='flex'; wrapperEl.style.display='none'; }
    function hideLoading() { loadingEl.style.display='none'; wrapperEl.style.display='flex'; }

    function drawOverlay() {
      overlayCtx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
      for(var i=0;i<savedMeasurements.length;i++) { var m=savedMeasurements[i]; drawPoints(m.points,m.type,'#FF9F1A',0.75,m.label,false); }
      if(currentPoints.length>0) drawPoints(currentPoints,mode,'#FFFFFF',1.0,null,true);
    }

    function drawPoints(pts,type,color,alpha,label,isActive) {
      if(!pts||!pts.length) return;
      overlayCtx.save();
      overlayCtx.globalAlpha=alpha;
      if(type==='area'&&pts.length>2) {
        overlayCtx.beginPath(); overlayCtx.moveTo(pts[0].x,pts[0].y);
        for(var i=1;i<pts.length;i++) overlayCtx.lineTo(pts[i].x,pts[i].y);
        overlayCtx.closePath();
        overlayCtx.fillStyle=color; overlayCtx.globalAlpha=alpha*0.18; overlayCtx.fill();
        overlayCtx.globalAlpha=alpha;
      }
      if(pts.length>1) {
        overlayCtx.beginPath(); overlayCtx.strokeStyle=color; overlayCtx.lineWidth=2.5; overlayCtx.lineCap='round'; overlayCtx.lineJoin='round';
        overlayCtx.moveTo(pts[0].x,pts[0].y);
        for(var i=1;i<pts.length;i++) overlayCtx.lineTo(pts[i].x,pts[i].y);
        if(type==='area'&&pts.length>2) overlayCtx.closePath();
        overlayCtx.stroke();
      }
      for(var i=0;i<pts.length;i++) {
        var r=(i===0&&isActive&&type==='area')?8:5;
        overlayCtx.beginPath(); overlayCtx.arc(pts[i].x,pts[i].y,r,0,Math.PI*2);
        overlayCtx.fillStyle=color; overlayCtx.globalAlpha=alpha; overlayCtx.fill();
        if(i===0&&type==='area'&&pts.length>=3&&isActive) {
          overlayCtx.beginPath(); overlayCtx.arc(pts[0].x,pts[0].y,18,0,Math.PI*2);
          overlayCtx.strokeStyle=color; overlayCtx.lineWidth=1.5; overlayCtx.globalAlpha=alpha*0.5; overlayCtx.stroke();
        }
      }
      if(label&&pts.length) {
        var cx=0,cy=0;
        for(var i=0;i<pts.length;i++){cx+=pts[i].x;cy+=pts[i].y;} cx/=pts.length; cy/=pts.length;
        overlayCtx.globalAlpha=alpha;
        overlayCtx.font='bold 12px -apple-system,sans-serif';
        var tw=overlayCtx.measureText(label).width, pad=5, lh=20;
        overlayCtx.fillStyle='rgba(29,37,48,0.92)';
        var rx=cx-tw/2-pad, ry=cy-lh-6, rw=tw+pad*2;
        overlayCtx.beginPath();
        if(overlayCtx.roundRect){overlayCtx.roundRect(rx,ry,rw,lh,4);}else{overlayCtx.rect(rx,ry,rw,lh);}
        overlayCtx.fill();
        overlayCtx.fillStyle='#FF9F1A';
        overlayCtx.fillText(label,cx-tw/2,cy-10);
      }
      overlayCtx.restore();
    }

    function coords(clientX,clientY) {
      var rect=overlayCanvas.getBoundingClientRect();
      return { x:(clientX-rect.left)*(overlayCanvas.width/rect.width), y:(clientY-rect.top)*(overlayCanvas.height/rect.height) };
    }

    function handleTap(cx,cy) {
      if(mode==='none') return;
      var p=coords(cx,cy);
      if(mode==='area'&&currentPoints.length>=3) {
        var f=currentPoints[0], d=Math.sqrt(Math.pow(p.x-f.x,2)+Math.pow(p.y-f.y,2));
        if(d<24){ postRN({type:'measurementComplete',mode:'area',points:currentPoints,width:canvasW,height:canvasH,naturalPageW:naturalPageW}); return; }
      }
      currentPoints.push(p); drawOverlay();
      if(mode==='distance'&&currentPoints.length===2) {
        postRN({type:'measurementComplete',mode:'distance',points:currentPoints,width:canvasW,height:canvasH,naturalPageW:naturalPageW}); return;
      }
      postRN({type:'pointAdded',x:p.x,y:p.y,count:currentPoints.length,width:canvasW,height:canvasH,naturalPageW:naturalPageW});
    }

    overlayCanvas.addEventListener('touchend',function(e){
      e.preventDefault(); e.stopPropagation();
      if(mode==='none') return;
      var now=Date.now(); if(now-lastTap<250) return; lastTap=now;
      var t=e.changedTouches[0]; handleTap(t.clientX,t.clientY);
    },{passive:false});
    overlayCanvas.addEventListener('click',function(e){ if(mode!=='none') handleTap(e.clientX,e.clientY); });

    function onMsg(data) {
      var msg; try{msg=typeof data==='string'?JSON.parse(data):data;}catch(e){return;}
      switch(msg.type){
        case 'loadPdf': loadPdf(msg.base64); break;
        case 'setMode':
          mode=msg.mode;
          wrapperEl.style.overflowY=mode==='none'?'auto':'hidden';
          break;
        case 'clearCurrentPoints': currentPoints=[]; drawOverlay(); break;
        case 'undoPoint': currentPoints.pop(); drawOverlay(); break;
        case 'setSavedMeasurements': savedMeasurements=msg.measurements||[]; drawOverlay(); break;
        case 'setPage':
          currentPage=msg.page; currentPoints=[]; savedMeasurements=[];
          renderPage(currentPage); break;
        case 'finishArea':
          if(currentPoints.length>=3) postRN({type:'measurementComplete',mode:'area',points:currentPoints,width:canvasW,height:canvasH,naturalPageW:naturalPageW});
          break;
      }
    }
    window.addEventListener('message',function(e){onMsg(e.data);});
    document.addEventListener('message',function(e){onMsg(e.data);});

    async function loadPdf(base64) {
      showLoading('Decoding PDF...');
      try {
        var bin=atob(base64), bytes=new Uint8Array(bin.length);
        for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        showLoading('Rendering PDF...');
        pdfDoc=await pdfjsLib.getDocument({data:bytes}).promise;
        postRN({type:'pdfLoaded',pages:pdfDoc.numPages});
        await renderPage(1);
      } catch(err) {
        loadingEl.querySelector('span').textContent='Error: '+err.message;
        postRN({type:'error',message:err.message});
      }
    }

    postRN({type:'ready'});
  </script>
</body>
</html>`;
}
