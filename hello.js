Deno.serve(async (req)=>{
    var kv = await Deno.openKv()
    await kv.set(["123"],Date.now())
    return new Response((await kv.get(["123"])).value)
})
