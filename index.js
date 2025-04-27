var PORT_RANGE = [30000, 40000]
var CLEAR_TIMEOUT = 10 * 60 * 1000;

var FILE_MODE = import.meta.url.indexOf("file:") === 0 || false;
var WORKER_LIST = {}
setInterval(() => {
    for (let i in WORKER_LIST) {
        if ((Date.now() - WORKER_LIST[i].lasttime) > CLEAR_TIMEOUT) {
            console.log("🔚 时间差不多咯，结束 " + i)
            WORKER_LIST[i].worker.terminate()
            delete WORKER_LIST[i]
        }
    }
}, 60 * 1000);


try {
    Deno.serve({ port: Deno.env.get("PORT") || 8000 }, handler);
} catch (e) { console.error(e) }


async function handler(req) {
    try {
        var host = req.url.match(/^https?:\/\/([^\/]+)/)[1];
        var js = host.split('.').shift();
        var handler_js = import.meta.url.match(/^([^\?]+)/)[1];
        if (js.indexOf("re-") === 0) {
            js = js.slice(3)

            handler_js = handler_js.slice(0, handler_js.lastIndexOf("/")) + "/" + js;

            if (WORKER_LIST[handler_js]) {
                console.log("🔄 重新加载 " + handler_js)
                WORKER_LIST[handler_js].worker.terminate()
                delete WORKER_LIST[handler_js]
            }
        }
        handler_js = handler_js.slice(0, handler_js.lastIndexOf("/")) + "/" + js;
        if (!WORKER_LIST[handler_js]) {
            var js_code = "";
            if (FILE_MODE) {
                try {
                    js_code = await Deno.readTextFile(handler_js.replace(/^file:\/\/\//, "") + ".js");
                } catch (e) {
                    js_code = await Deno.readTextFile(handler_js.replace(/^file:\/\/\//, "") + ".ts");
                }
            } else {
                try {
                    js_code = await fetch(handler_js + ".js");
                    js_code = await js_code.text();
                } catch (e) {
                    js_code = await fetch(handler_js + ".ts");
                    js_code = await js_code.text();
                }
            }

            var { worker, port } = await ServeInWorker(js_code, PORT_RANGE, host)

            WORKER_LIST[handler_js] = {
                code: js_code,
                url: "http://localhost:" + port,
                worker,
                lasttime: Date.now()
            }

        }

        WORKER_LIST[handler_js].lasttime = Date.now()
        return fetch(req.url.replace(/^https?:\/\/[^\/]+/, WORKER_LIST[handler_js].url), req)


    } catch (e) {
        return new Response(e.message, { status: 500 })
    }
}

async function ServeInWorker(jsCode, PORT_RANGE, host) {
    // 构建Worker脚本，包装提供的代码
    const workerScript = `
//Hook Deno.serve 实现固定端口
;(()=>{
const originalServe = Deno.serve;
Deno.serve = function hookedServe(optionsOrHandler, maybeHandler) {
 
  
  let handler;
  let options = {};
  
  // 处理不同的参数形式
  if (typeof optionsOrHandler === "function" || optionsOrHandler instanceof Request) {
    handler = optionsOrHandler;
    options = {};
  } else {
    options = optionsOrHandler || {};
    handler = maybeHandler;
  }
  
  // 强制使用固定端口
  var PORT_RANGE = ${JSON.stringify(PORT_RANGE)}


  var opt_listen = options.onListen || null
  options.onListen =  (...args) => {
    //console.log(args[0].port)
     console.log('🌐 ${host} running on http://localhost:'+args[0].port);
       self.postMessage({ success: true ,port: args[0].port});
       if(opt_listen) return opt_listen(...args)
    }
 
  // 调用原始的 serve 函数

  let hookHandler = (req)=>{

    const newHeaders = new Headers(req.headers);
  newHeaders.set("host", "${host}");
  
  const newRequest = new Request(req.url.replace(/^https?:\\/\\/[^\\/]+/,"https://${host}"), {
    method: req.method,
    headers: newHeaders,
    body: req.body,
    singal: req.singal
  });

  return handler(newRequest)
}
  for(let i=0;i<3;i++)
  try{
    let FIXED_PORT = parseInt(PORT_RANGE[0]+(Math.random()*(PORT_RANGE[1]-PORT_RANGE[0])))
    options.port = FIXED_PORT;

  
  // 添加启动日志
 

  return originalServe(options, hookHandler);
}catch(error){

console.error(error.message)
if(i===2){
 self.postMessage({
            success: false, 
            error: {
              message: error.message,
              name: error.name,
              stack: error.stack
            }
          })
          }
}


          
};
})();

try{
${jsCode}
} catch (error) {
   self.postMessage({
            success: false, 
            error: {
              message: error.message,
              name: error.name,
              stack: error.stack
            }
          })
}
   /*   // 设置消息处理程序接收要执行的代码
      self.onmessage = async (e) => {
        try {
          // 使用Function构造函数创建可执行的函数
          // 添加return语句以便捕获结果
          const wrappedCode = 'return (async () => {  ' + e.data + ' })();';
          const execFunc = new Function(wrappedCode);
          
          // 执行代码并获取结果
          const result = await execFunc();
          
          // 将结果发送回主线程
         // self.postMessage({ success: true, result });
        } catch (error) {
          // 发送错误信息回主线程
          self.postMessage({ 
            success: false, 
            error: { 
              message: error.message,
              name: error.name,
              stack: error.stack
            }
          });
        }
      };*/
    `;

    // 创建data URL作为Worker脚本源
    const dataUrl = `data:application/typescript;charset=utf-8,${encodeURIComponent(workerScript)}`;

    // 创建Worker并设置严格的权限
    const worker = new Worker(dataUrl, {
        type: "module",
        deno: {
            namespace: false, // 不允许访问Deno命名空间
            permissions: {
                net: true,     // 允许网络访问
                read: false,    // 不允许文件读取
                write: false,   // 不允许文件写入
                env: false,     // 不允许环境变量访问
                hrtime: true,  // 允许高精度时间
                run: false      // 不允许运行子进程
            }
        }
    });

    return new Promise((resolve, reject) => {
        // 设置超时处理
        var timeout = 3000
        const timeoutId = setTimeout(() => {
            worker.terminate();
            reject(new Error(`Serve timed out after ${timeout}ms`));
        }, timeout);

        // 处理Worker发送的消息
        worker.onmessage = (e) => {
            clearTimeout(timeoutId);

            if (e.data.success) {
                resolve({ worker, port: e.data.port })
            } else {
                const error = new Error(e.data.error.message);
                error.name = e.data.error.name;
                error.stack = e.data.error.stack;
                reject(error);
            }
        };

        worker.addEventListener("error", (event) => {
           // console.error("工作线程错误事件:", event);
           clearTimeout(timeoutId);
           worker.terminate(); // 立即释放资源
           reject(new Error(`Worker error`));

            event.preventDefault();
          });
       
    });
}


