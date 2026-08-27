# vhs script for the demo GIF: `vhs docs/demo.tape` writes docs/public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built (npm run build)
#   * run it from the repository root, not from docs/
#   * WOODPECKER_URL and WOODPECKER_TOKEN exported, pointing at an instance with
#     a failed pipeline. Use a throwaway one: this tape only reads, but the
#     recording ends up in a public repository, and repository names, branches
#     and commit messages all appear in it.
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * `-e` goes AFTER the command being launched, and the Inspector does not
#     inherit the shell environment: `X=1 npx … inspector …` silently applies
#     nothing at all. That is why the wrapper below passes them explicitly — and
#     why it is a wrapper: typed out in full, the invocation is 200 characters
#     and the recording becomes a film about a command line rather than about
#     what it answers.
#   * three beats, no more

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 420
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type `wp() { npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e WOODPECKER_URL=$WOODPECKER_URL -e WOODPECKER_TOKEN=$WOODPECKER_TOKEN "$@" 2>/dev/null; }` Enter
Type `essential() { npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e WOODPECKER_ALLOW_TOOLS=essential "$@" 2>/dev/null; }` Enter
Type "clear" Enter
Sleep 500ms
Show

Type "# which step broke?" Enter
Sleep 800ms
Type `wp --method tools/call --tool-name get_pipeline --tool-arg repo_id=1 --tool-arg number=3 | jq -r '.content[0].text' | grep -E '"(name|state)"' | paste -sd' ' | fold -sw 100` Enter
Sleep 14s

Type "# and why" Enter
Sleep 800ms
Type `wp --method tools/call --tool-name get_step_logs --tool-arg repo_id=1 --tool-arg number=3 --tool-arg step_id=6 --tool-arg limit=4 | jq -r '.content[0].text' | tail -5` Enter
Sleep 14s

Type "# 71 tools, or the curated eight" Enter
Sleep 800ms
Type `essential --method tools/list | jq -r '.tools[].name' | paste -sd' ' | fold -sw 100` Enter
Sleep 12s
