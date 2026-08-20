/**
 * Built-in rotating, time-aware greeting pool for the GUI and TUI landing heroes.
 * Pick once per surface mount/session so the greeting does not shuffle mid-view.
 *
 * Style guide for additions: one short line (under ~32 characters), questions
 * end with "?", and statements carry no period.
 */

const UNIVERSAL_GREETINGS: readonly string[] = [
	"Let's build",
	"Ready when you are",
	"What should we build?",
	"Easy as π",
	"New task, who dis?",
	"Make it so",
	"Where were we?",
	"Today's the day",
	"Say the word",
	"Let's make something weird",
];

const WEEKEND_GREETINGS: readonly string[] = ["Weekend build?", "No standup today", "Side project time?"];

const FRIDAY_GREETINGS: readonly string[] = ["Deploy on Friday? Bold", "Read-only Friday?"];

const MONDAY_GREETINGS: readonly string[] = ["New week, clean diff", "Monday momentum?"];

interface GreetingBucket {
	readonly fromHour: number;
	readonly toHour: number;
	readonly phrases: readonly string[];
}

const GREETING_BUCKETS: readonly GreetingBucket[] = [
	{
		fromHour: 0,
		toHour: 4,
		phrases: [
			"Working late?",
			"Midnight oil?",
			"Quiet hours, deep focus",
			"Still shipping?",
			"Sleep is a suggestion",
			"Insomnia-driven development?",
			"The bugs are asleep. Strike now",
			"Nocturnal mode engaged",
		],
	},
	{
		fromHour: 5,
		toHour: 7,
		phrases: ["Up early?", "Early start?", "Dawn patrol?", "Before the standup crowd", "First commit of the day?"],
	},
	{
		fromHour: 8,
		toHour: 11,
		phrases: [
			"Good morning",
			"Fresh start?",
			"What's first today?",
			"Coffee, then code?",
			"Inbox later, build now",
			"Prime commit hours",
		],
	},
	{
		fromHour: 12,
		toHour: 16,
		phrases: [
			"Good afternoon",
			"Back at it?",
			"What's next?",
			"Post-lunch push?",
			"Meetings over. Let's go",
			"Slump? Never heard of it",
		],
	},
	{
		fromHour: 17,
		toHour: 20,
		phrases: [
			"Good evening",
			"Evening session?",
			"One more thing?",
			"Golden hour for shipping",
			"After-hours mode",
			"Wind down or wind up?",
		],
	},
	{
		fromHour: 21,
		toHour: 23,
		phrases: [
			"Late session?",
			"Night shift?",
			"Let's wrap something up",
			"One last push?",
			"Commit before midnight?",
			"The night is young(ish)",
		],
	},
];

export function pickNewThreadGreeting(now: Date = new Date(), random: () => number = Math.random): string {
	const hour = now.getHours();
	const day = now.getDay();
	const bucket = GREETING_BUCKETS.find((entry) => hour >= entry.fromHour && hour <= entry.toHour);
	const pool = [...(bucket?.phrases ?? []), ...UNIVERSAL_GREETINGS];
	const isWeekendDaytime = (day === 0 || day === 6) && hour >= 8 && hour <= 20;
	if (isWeekendDaytime) pool.push(...WEEKEND_GREETINGS);
	if (day === 5) pool.push(...FRIDAY_GREETINGS);
	if (day === 1) pool.push(...MONDAY_GREETINGS);
	const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
	return pool[index] ?? UNIVERSAL_GREETINGS[0] ?? "Let's build";
}
