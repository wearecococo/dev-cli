-- Minimal cococo integration example.
exports = {}

function exports.on_timer(ctx, timer)
  if timer.name == "heartbeat" then
    ctx.log:info("heartbeat tick")
  end
end
