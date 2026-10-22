/**
 * Mimir's system prompt, split into small modules. Each module owns one
 * capability: the few sentences that explain it, plus the exact tools it
 * brings. The loader (loader.ts) sends only the modules a turn needs, one at
 * a time, instead of one prompt that describes everything on every message.
 *
 * Why this matters: a local 3B model has a 4K context window, and a tool's
 * JSON schema costs far more tokens than the prose about it. Measured on a
 * default llama3.2 setup, the old always-on tool list alone was ~2,900 tokens
 * (create_skill by itself ~1,000) for a message that just said "hi".
 *
 * Rules for editing this file:
 *  - `required` is only for what every single turn needs. Today that is the
 *    one-paragraph `core` module and nothing else.
 *  - Every tool belongs to exactly one module (tests enforce this), so a
 *    capability can never be described without its tools or offered without
 *    its description — the mismatch that made small models write tool-call
 *    JSON into chat.
 *  - `coreTools` is what a small ("core" tier) model gets. A tool listed only
 *    in `tools` is for larger models.
 */

export type PromptTier = "core" | "full";

export interface PromptModule {
  id: string;
  title: string;
  /** One line for the UI: what the module is for. */
  summary: string;
  /** Plain-words hint for the UI: when it loads. */
  when: string;
  /** Loaded on every turn, whatever the user said. */
  required: boolean;
  /** Tiers allowed to load it at all. */
  tiers: PromptTier[];
  /** Any match against the user's message loads an optional module. */
  triggers: RegExp[];
  /** Prompt text for larger models (and the default). May be empty for a tools-only module. */
  text: string;
  /** Shorter text for the core tier; falls back to `text` when omitted. */
  coreText?: string;
  /** Every tool this module can bring (larger models). */
  tools: string[];
  /** The subset a core-tier (small local) model gets. */
  coreTools: string[];
}

export const CORE_MODULE_ID = "core";
export const ABOUT_MODULE_ID = "about";

export const PROMPT_MODULES: PromptModule[] = [
  {
    id: CORE_MODULE_ID,
    title: "Core",
    summary: "Who Mimir is and the rules that apply to every reply.",
    when: "Every message",
    required: true,
    tiers: ["core", "full"],
    triggers: [],
    text:
      "You are Mimir, a calm, capable desktop assistant running in the Mimir tab of BridgeDeck, the user's own app " +
      "for their Mac and Windows PC. Be direct, helpful and concise — you are a voice-and-chat " +
      "assistant, not a document generator. Answer the user's actual message naturally. Never mention tool names, " +
      "file names, timestamps or implementation details unless asked. Never claim to have changed a file, " +
      "remembered something or taken an action unless a tool call actually succeeded, and never describe a tool " +
      "call in text instead of making it. Most messages are ordinary conversation: answer them in plain sentences, " +
      "with no tool call and no code; a greeting gets a short greeting back. Write code only when the user asks for " +
      "it, in a fenced block (``` and the language name on their own line, the code, then a closing ```). Dollar " +
      "signs are only for math, never for code.",
    tools: [],
    coreTools: []
  },
  {
    id: ABOUT_MODULE_ID,
    title: "About Mimir",
    summary: "What Mimir is, where it runs and what it can do here.",
    when: "You ask what Mimir is, what it can do or which tools it has",
    required: false,
    tiers: ["core", "full"],
    triggers: [
      /\b(who|what) are you\b/i,
      /\bwhat (can|do) you (do|have|know)\b/i,
      /\b(what|which) (tools|apps?|abilities|capabilities|features|skills)\b/i,
      /\byour (tools|abilities|capabilities|features|access)\b/i,
      /\b(aware|know) (of|about) (the |this )?(app|program|bridgedeck|yourself|mimir)\b/i,
      /\b(aware|access)\b.{0,40}\b(app|tools?|running|program)\b/i,
      /\bbridgedeck\b/i
    ],
    // Filled in below from the other modules, so it never lists something Mimir can't do.
    text: "",
    coreText: "",
    tools: [],
    coreTools: []
  },
  {
    id: "memory",
    title: "Memory",
    summary: "Remember durable facts about you between conversations.",
    when: "You ask Mimir to remember something, or share a lasting preference",
    required: false,
    tiers: ["core", "full"],
    triggers: [
      /\b(remember|memori[sz]e|forget|don'?t forget|keep in mind|my name is|call me|going forward|from now on)\b/i,
      /\bi (prefer|like|love|hate|always|never|am allergic)\b/i
    ],
    coreText:
      "Use memory_replace only when the user asks you to remember something, never for greetings, small talk or test " +
      "phrases. Send the whole new MEMORY.md, consolidated, not a diff. Never claim to remember something you did not write.",
    text:
      "Your long-term memory is MEMORY.md and what you know about the user is USER.md. Use memory_replace or " +
      "user_replace only when the user asks you to remember something or shares a lasting fact they'd clearly want " +
      "kept, never for greetings, small talk or test phrases; send " +
      "the whole new file, consolidated, not a diff. daily_log_append adds one short line to today's log. Never " +
      "claim to remember something you did not write.",
    tools: ["memory_replace", "user_replace", "daily_log_append"],
    coreTools: ["memory_replace"]
  },
  {
    id: "tasks",
    title: "Deadlines",
    summary: "Keep the running list of deadlines and to-dos.",
    when: "You mention a deadline, assignment or due date",
    required: false,
    tiers: ["full"],
    triggers: [
      /\b(due|deadline|assignment|homework|exam|midterm|quiz|submit|to-?dos?|tasks?)\b/i,
      /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week|the \d)/i
    ],
    text:
      "TASKS.md is the user's running list of deadlines, changed with tasks_replace. When the user mentions " +
      "something with a deadline, add it. Write the date as YYYY-MM-DD in the line (for example " +
      "\"- Lab 3 report due 2026-08-15\") even if they said \"next Friday\"; that exact format drives the " +
      "due-soon notifications. Mark a line \"[x]\" when it is done. Send the whole new file, not a diff.",
    tools: ["tasks_replace"],
    coreTools: []
  },
  {
    id: "projects",
    title: "Project files",
    summary: "Read, write and search the files in your Projects folder.",
    when: "You talk about files, documents, drafts, reports or PDFs",
    required: false,
    tiers: ["core", "full"],
    triggers: [
      /\b(files?|folders?|projects?|documents?|drafts?|essay|report|syllabus|attach(ed|ment)?|pdf)\b/i,
      /\b(save|rewrite|proofread|summari[sz]e)\b/i,
      /\bwrite (me )?(a|an|up)\b/i
    ],
    coreText:
      "The user's own files live in a separate Projects folder: list_project_files, read_project_file and " +
      "write_project_file. An attached file's content is already inline in the message, so no tool is needed to read it.",
    text:
      "The user's own files — schoolwork, notes, datasheets, drafts — live in a Projects folder, separate from your " +
      "own source code: list_project_files, read_project_file and write_project_file. An attached file's content is " +
      "already inline in the message. Every save is versioned: use " +
      "list_project_file_history and revert_project_file to bring back an older version, export_to_pdf for a real " +
      "PDF, semantic_search_project_files for questions about meaning and search_project_files for an exact phrase.",
    tools: [
      "list_project_files",
      "read_project_file",
      "write_project_file",
      "search_project_files",
      "list_project_file_history",
      "revert_project_file",
      "export_to_pdf",
      "semantic_search_project_files",
      "reveal_project_file"
    ],
    coreTools: ["list_project_files", "read_project_file", "write_project_file"]
  },
  {
    id: "compute",
    title: "Calculations",
    summary: "Run real Python for maths, conversions and plots.",
    when: "You ask for a calculation, conversion, plot or anything numeric",
    required: false,
    tiers: ["core", "full"],
    triggers: [
      /\b(calculat\w*|compute\w*|convert\w*|solve|equation|integral|derivative|matrix|python|plot|graph|chart|simulat\w*|statistic\w*|average|median|percent\w*|sqrt|square root|times|plus|minus|divided by|multiplied)\b/i,
      /\bhow (many|much|long|far|fast)\b/i,
      /\d\s*%/,
      /\d\s*[-+*/^×÷]\s*\d/
    ],
    text:
      "For anything numeric you could get wrong by reasoning alone — calculations, unit conversions, symbolic maths — " +
      "use run_python (numpy, sympy, pandas and matplotlib are available; variables persist across calls). Never " +
      "present a computed-sounding number you did not run. For a plot, use matplotlib inside run_python: any open " +
      "figure is shown to the user automatically.",
    tools: ["run_python", "reset_python"],
    coreTools: ["run_python"]
  },
  {
    id: "math",
    title: "Equations and diagrams",
    summary: "Write maths in LaTeX and draw structural diagrams.",
    when: "You ask about equations, circuits, physics or diagrams",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(latex|equation|formula|circuit|diagram|flow ?chart|state machine|mermaid|physics|draw|sketch|derive|proof)\b/i],
    text:
      "Write maths in LaTeX: $...$ inline, $$...$$ for a standalone equation. For system diagrams, circuit " +
      "topology, state machines or flowcharts use a fenced ```mermaid block. Mermaid cannot draw a picture of an " +
      "object or scene; for that, compose simple shapes with matplotlib inside run_python.",
    tools: [],
    coreTools: []
  },
  {
    id: "skills",
    title: "Skills",
    summary: "Teach Mimir a reusable Python routine and run it later.",
    when: "You ask Mimir to learn, save or reuse something",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(skills?|teach yourself|learn (how|to)|give yourself|new (ability|capabilit\w+)|reusable|automate|create_skill|run_skill)\b/i],
    coreText:
      "create_skill saves a reusable Python routine (it is run once to verify it); list_skills and run_skill reuse " +
      "it. A skill saved with parameters becomes its own tool, skill_<name>. Never say a skill works unless it was verified.",
    text:
      "create_skill saves a reusable Python routine under a short name, with a category (such as Math or Circuits) " +
      "and builds_on when it extends an existing skill. It is run once to verify it; list_skills and run_skill " +
      "reuse it, and verify_skill re-checks it. A skill saved with parameters becomes its own tool, skill_<name>. " +
      "Prefer one skill with several related functions over many tiny ones. Never say a skill works unless it was verified.",
    tools: ["create_skill", "list_skills", "run_skill", "verify_skill"],
    coreTools: ["create_skill", "list_skills", "run_skill"]
  },
  {
    id: "skill_packs",
    title: "Expert playbooks",
    summary: "Follow step-by-step expert methods from installed skill packs.",
    when: "You ask for a known kind of work, like a literature review or risk register",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(playbook|method(ology)?|framework|literature review|study plan|risk register|code review|expert)\b/i],
    text:
      "When a task is a known kind of work, skill_find looks for an expert method in the installed skill packs; " +
      "skill_read opens the best match and you follow it. skill_run_script runs one of its scripts in the sandbox.",
    tools: ["skill_find", "skill_read", "skill_run_script"],
    coreTools: ["skill_find", "skill_read", "skill_run_script"]
  },
  {
    id: "coding",
    title: "Coding",
    summary: "Read, search and edit code, and run commands, in your coding folder.",
    when: "You ask about code, a bug, a build, tests or a terminal command",
    required: false,
    tiers: ["core", "full"],
    triggers: [
      /\b(code|coding|function|class|bug|debug|compile|build|tests?|script|refactor|implement|stack trace|error message|terminal|shell|command line|npm|pip|cargo|python file)\b/i,
      /\.(py|ts|tsx|js|jsx|rs|go|java|c|cpp|h|cs|rb|swift|kt|sh|json|ya?ml|toml)\b/i
    ],
    text:
      "For code work in the coding folder: Read shows a file with line numbers; Grep and Glob find things; Edit changes a " +
      "file by replacing exact text (Read it first and copy old_string exactly; make it unique); Write is for new files; " +
      "Bash runs a command (the user approves each one). Paths are relative to the coding folder. For work with several " +
      "steps keep a TodoWrite list. Check your change worked (run the tests or the program) before saying it's done.",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "TodoWrite"],
    coreTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"]
  },
  {
    id: "self_edit",
    title: "Self-editing",
    summary: "Read and change Mimir's own source code, with your sign-off.",
    when: "You ask Mimir to change its own code or behaviour",
    required: false,
    tiers: ["full"],
    triggers: [/\b(your (own )?(code|source)|edit yourself|modify yourself|change how you|improve yourself|self[- ]?edit|propose_edit)\b/i],
    text:
      "You can read, propose and apply changes to your own source code with propose_edit, only under src/main, " +
      "src/renderer or skills/, then restart into the new version. Use tier \"skill\" for files under skills/ " +
      "(applied immediately) and tier \"core\" for src/main or src/renderer (full verification and, unless " +
      "auto-approve is on, the user's explicit sign-off). Never claim a change you did not write and apply. " +
      "propose_edit is for source code only — never for memory.",
    tools: ["read_file", "list_files", "search", "propose_edit"],
    coreTools: []
  },
  {
    id: "web",
    title: "Web research",
    summary: "Search and read public web pages.",
    when: "You ask Mimir to look something up online",
    required: false,
    tiers: ["full"],
    triggers: [/\b(search the web|look ?up|google|latest|news|online|website|https?:\/\/|www\.)/i],
    text: "web_lookup searches the public web and web_read reads a page; say where a fact came from.",
    tools: ["web_lookup", "web_read"],
    coreTools: []
  },
  {
    id: "engineering",
    title: "Engineering tools",
    summary: "CAD, circuit simulation and design-rule checks.",
    when: "You mention FreeCAD, CalculiX, ngspice, KiCad or simulation",
    required: false,
    tiers: ["full"],
    triggers: [/\b(freecad|calculix|ngspice|kicad|cad|fea|spice|schematic|pcb|netlist|stl|simulation|engineering)\b/i],
    text:
      "Engineering work runs through real tools: create a project, then work its stages in order, recording each " +
      "revision. Report only what a tool actually returned; never claim a simulation or check ran when it did not.",
    tools: [
      "inspect_engineering_environment",
      "open_engineering_app",
      "create_engineering_project",
      "run_freecad_project_macro",
      "run_calculix_simulation",
      "run_ngspice_simulation",
      "run_kicad_erc",
      "run_kicad_drc",
      "inspect_engineering_workflow",
      "advance_engineering_stage",
      "record_engineering_revision"
    ],
    coreTools: []
  },
  // BridgeDeck's own data. Tools only (their descriptions carry the guidance), and each group loads on its own,
  // so asking about the calendar never puts the Messages tools in front of a small model.
  {
    id: "bd_notes",
    title: "BridgeDeck notes",
    summary: "Search, read and write your BridgeDeck notes.",
    when: "You mention notes",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(notes?|notebook|jot|write (it )?down)\b/i],
    text: "",
    tools: ["notes_search", "note_read", "note_create", "note_append"],
    coreTools: ["notes_search", "note_read"]
  },
  {
    id: "bd_calendar",
    title: "BridgeDeck calendar",
    summary: "Look up and add calendar events.",
    when: "You ask about your schedule, events or a day",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(calendar|schedule|events?|meetings?|appointments?|agenda|today|tomorrow|tonight|this (week|weekend)|next (week|month)|free (time|slot)|remind(er)? me)\b/i],
    text: "",
    tools: ["calendar_list", "calendar_add", "calendar_delete"],
    coreTools: ["calendar_list", "calendar_add"]
  },
  {
    id: "bd_checklist",
    title: "BridgeDeck checklist",
    summary: "Add to and tick off your checklist.",
    when: "You mention your checklist or to-do list",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(checklist|to-?do|task list|tick|check (it )?off)\b/i, /\badd .{1,40} to (my|the) list\b/i],
    text: "",
    tools: ["checklist_add", "checklist_tick"],
    coreTools: ["checklist_add", "checklist_tick"]
  },
  {
    id: "bd_brief",
    title: "Daily brief",
    summary: "Summarise your day from BridgeDeck.",
    when: "You ask for a brief or what is on today",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(brief|briefing|my day|catch me up|overview|what'?s (up|going on) (today|this morning))\b/i],
    text: "",
    tools: ["daily_brief"],
    coreTools: ["daily_brief"]
  },
  {
    id: "tutor",
    title: "Tutor",
    summary: "Helps with coursework by hints first, so the student does the learning.",
    when: "You ask about homework, a problem, an exam, or why your code or circuit doesn't work",
    required: false,
    tiers: ["core", "full"],
    triggers: [
      /\b(home ?work|hw ?\d*|problem( set)?s?|exercise|assignment|exam|midterm|final|quiz|lab report|prelab)\b/i,
      /\b(solve|derive|prove|simplify|calculate|compute|find the)\b/i,
      /\b(doesn'?t compile|fails when it runs|my (program|code|circuit) (fails|is wrong|doesn'?t work))\b/i
    ],
    coreText:
      "For coursework, teach rather than solve: ask what the user tried, then give one hint at a time (the idea, then " +
      "the next step, then a check of their setup). Give a full solution only when they ask for it after trying, or " +
      "say it's ungraded practice. For code, point at the line and explain the mistake instead of rewriting it.",
    text:
      "When the user is working on coursework (homework, a problem set, a lab, exam practice), teach rather than " +
      "solve. First ask what they tried or where they're stuck, unless they already said. Then give one hint at a " +
      "time, smallest first: the idea or formula that applies (with the book page if you know it), then the next " +
      "step, then a check of their setup or arithmetic. Let them do each step. Give a complete worked solution only " +
      "when they ask for it after trying, or say it's ungraded practice; even then, explain each step. For a " +
      "program or circuit that fails, point at the line or part that's wrong and explain why in plain words; " +
      "don't hand back fixed code unless they ask for it. Never help with a quiz or exam that is being taken now.",
    tools: [],
    coreTools: []
  },
  {
    id: "bd_study",
    title: "BridgeDeck study",
    summary: "Search your course material and make flashcards.",
    when: "You mention a course, lecture, study or flashcards",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(study|courses?|lectures?|flash ?cards?|classes|class|textbook|quiz me)\b/i],
    text:
      "Answer from the user's own course material when you can: search it, read the pages, and say which book and " +
      "page an answer came from. If their material doesn't cover something, say so rather than guessing.",
    tools: ["study_search", "study_courses", "study_read", "flashcards_add"],
    coreTools: ["study_search"]
  },
  {
    id: "bd_assignments",
    title: "Assignments, grades and classes",
    summary: "What's due, how your courses are going, when and where classes are.",
    when: "You ask what's due, about grades, classes or your study plan",
    required: false,
    tiers: ["core", "full"],
    triggers: [/\b(due|deadlines?|homework|assignments?|grades?|gpa|classes|class|schedule|midterms?|finals?|study plan)\b/i],
    text:
      "For deadlines, grades, class times and the study plan, look them up with the study tools rather than guessing, " +
      "and give times in the user's own time zone.",
    tools: ["study_assignments", "study_grades", "study_schedule", "study_plan", "study_suggest", "study_photo"],
    coreTools: ["study_assignments"]
  },
  {
    id: "bd_messages",
    title: "Messages",
    summary: "Read your chats and send messages or files.",
    when: "You ask about messages, or to send something to someone",
    required: false,
    tiers: ["full"],
    triggers: [/\b(messages?|imessage|sms|chats?|reply|texts?|send (a |the )?(file|message|text))\b/i],
    text: "",
    tools: ["messages_chats", "messages_read", "message_send", "files_send"],
    coreTools: []
  },
  {
    id: "bd_devices",
    title: "Your computers",
    summary: "Check, wake and look at your other computers; use the clipboard.",
    when: "You mention another computer, the clipboard or the screen",
    required: false,
    tiers: ["full"],
    triggers: [/\b(computers?|clipboard|screen|wake|laptop|pc)\b/i],
    text: "",
    tools: ["computers_status", "computer_look", "computer_wake", "clipboard_read", "clipboard_write"],
    coreTools: []
  },
  {
    id: "bd_boards",
    title: "Project boards",
    summary: "List projects and move their task cards.",
    when: "You mention a project board or moving a task",
    required: false,
    tiers: ["full"],
    triggers: [/\b(kanban|board|task card|backlog)\b/i, /\bmove .{1,40} to (doing|done|todo|in progress)\b/i],
    text: "",
    tools: ["projects_list", "project_task_add", "project_task_move"],
    coreTools: []
  },
  {
    id: "bd_ai",
    title: "AI rooms",
    summary: "Post to BridgeDeck's AI rooms.",
    when: "You mention an AI room",
    required: false,
    tiers: ["full"],
    triggers: [/\b(ai rooms?|rooms?|other ai|post to)\b/i],
    text: "",
    tools: ["ai_rooms", "ai_post"],
    coreTools: []
  }
];

/** The About module's text: where Mimir runs and one line per capability the tier has. */
function aboutText(tier: PromptTier): string {
  const lines = PROMPT_MODULES.filter((m) => m.id !== CORE_MODULE_ID && m.id !== ABOUT_MODULE_ID && m.tiers.includes(tier)).map((m) => `- ${m.title}: ${m.summary}`);
  return [
    "About yourself, for when the user asks: you are Mimir, the assistant in BridgeDeck's Mimir tab. BridgeDeck is the user's desktop app " +
      "that pairs their Mac and Windows PC and has tabs for remote control, files, sync, Messages, mail, notes, calendar, study, projects " +
      "and more. You run on the models set in Settings (one model, or a Head, Executor and Checker team), often local ones. Your tools load " +
      "when a message needs them, so describe what you can do from this list rather than saying you don't know:",
    ...lines,
    "- Tool servers (MCP) and skill packs the user adds in Settings.",
    "Settings (the gear in the Mimir tab) is where the brain, voice, team, model servers and tool servers are set up."
  ].join("\n");
}

const about = PROMPT_MODULES.find((m) => m.id === ABOUT_MODULE_ID)!;
about.text = aboutText("full");
about.coreText = aboutText("core");

export function getPromptModule(id: string): PromptModule | undefined {
  return PROMPT_MODULES.find((m) => m.id === id);
}

/** Which module owns a tool, or undefined for tools outside the registry (dynamic skill_<name> tools). */
export function moduleForTool(tool: string): PromptModule | undefined {
  return PROMPT_MODULES.find((m) => m.tools.includes(tool));
}

/** Tool names a core-tier turn may ever offer — derived, so it can never drift from the prompt text. */
export function coreToolNames(): Set<string> {
  return new Set(PROMPT_MODULES.flatMap((m) => m.coreTools));
}
