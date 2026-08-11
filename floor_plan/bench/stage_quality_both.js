// Runs stage-quality reporting for both maintained benchmark DSLs.
// Usage: bun bench/stage_quality_both.js [seed...]
const seeds = process.argv.slice(2).filter(value => !Number.isNaN(Number(value)));
const selected = seeds.length ? seeds : Array.from({ length: 10 }, (_, i) => String(i + 1));
for (const dsl of ["bench/user.dsl", "bench/user_one_hall.dsl"]) {
    const result = Bun.spawnSync([process.execPath, "bench/stage_quality.js", "--dsl", dsl, ...selected], {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "inherit",
        stderr: "inherit",
    });
    if (result.exitCode !== 0) process.exit(result.exitCode);
    console.log("");
}
