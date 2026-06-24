-- Relai Wake: deliver a text message into a specific Terminal.app tab,
-- identified by its tty device, as if typed by the user. Used to "wake" an
-- idle interactive Claude Code session with new context (e.g. a relai task)
-- without starting a second process or requiring that session to poll.
--
-- Usage: osascript relai-wake.applescript <tty-suffix, e.g. "ttys005"> "<message>"

on run argv
	if (count of argv) < 2 then
		error "Usage: relai-wake.applescript <tty> <message>"
	end if
	set targetTty to item 1 of argv
	set msg to item 2 of argv

	tell application "Terminal"
		activate
		repeat with w in windows
			repeat with t in tabs of w
				if (tty of t) contains targetTty then
					do script msg in t
					return "ok: delivered to " & targetTty
				end if
			end repeat
		end repeat
	end tell

	error "relai-wake: no Terminal tab found with tty " & targetTty
end run
