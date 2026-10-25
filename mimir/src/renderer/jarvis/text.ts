/** Words for the Jarvis view: what a tool call is doing, and times, in plain English. */

const TOOL_WORDS: Array<[RegExp, string]> = [
  [/^calendar_(events|today|list)|^calendar$/, "Checking your calendar"],
  [/^calendar_(add|create)/, "Adding to your calendar"],
  [/^calendar_delete/, "Removing a calendar event"],
  [/^study_assignments/, "Looking at what's due"],
  [/^study_grades/, "Working out your grades"],
  [/^study_(schedule|plan)/, "Checking your class schedule"],
  [/^study_(search|read)/, "Reading your textbooks"],
  [/^study_photo/, "Looking at a photo"],
  [/^study_lecture/, "Reading a lecture transcript"],
  [/^study_flashcards/, "Writing flashcards"],
  [/^study_/, "Working in Study"],
  [/^notes?_(search|read|list)/, "Reading your notes"],
  [/^notes?_/, "Writing in your notes"],
  [/^message/, "Working in Messages"],
  [/^memory_/, "Updating what I remember"],
  [/^obsidian_search/, "Searching your Obsidian vault"],
  [/^obsidian_read/, "Reading a note in Obsidian"],
  [/^obsidian_write/, "Saving a note in Obsidian"],
  [/^web_lookup|websearch|web_search/i, "Searching the web"],
  [/^web_read|webfetch|fetch/i, "Reading a web page"],
  [/^(bash|run_command|terminal|execute)/i, "Running a command"],
  [/^(read|read_file|grep|glob|list_files)/i, "Looking through files"],
  [/^(edit|write|write_file|patch)/i, "Changing a file"],
  [/^run_python|^python/i, "Running Python"],
  [/^project/, "Working in Projects"],
  [/^computers?_/, "Checking your other computer"],
  [/^files?_send/, "Sending a file"]
];

/** "calendar_events" → "Checking your calendar"; MCP prefixes (mcp__mimir__…) are dropped. */
export function toolWords(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, "").replace(/^mimir[_.-]/, "");
  return TOOL_WORDS.find(([re]) => re.test(bare))?.[1] ?? `Using ${bare.replace(/_/g, " ")}`;
}

/** "9:30 AM" / "in 25 min" for something starting at `t`. */
export function startText(t: number, now = Date.now()): string {
  const mins = Math.round((t - now) / 60_000);
  if (mins > 0 && mins < 60) return `in ${mins} min`;
  if (mins <= 0 && mins > -60) return "now";
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "today 11:59 PM", "tomorrow 9 AM", "Fri 5 PM" for a deadline. */
export function dueText(t: number, now = Date.now()): string {
  const d = new Date(t), today = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 0) return `overdue (${time})`;
  return `${days === 0 ? "today" : days === 1 ? "tomorrow" : d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** The end of a long reply, for a caption: the last `max` characters, from a word boundary. */
export function captionTail(text: string, max = 280): string {
  const plain = text.replace(/```[\s\S]*?```/g, " [code] ").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(plain.length - max);
  return `…${cut.slice(cut.indexOf(" ") + 1)}`;
}
