import type { AuditConfig, InteractionType } from './types.js';

export function isBot(login: string): boolean {
	return login.endsWith('[bot]');
}

export function filterMembers(
	members: readonly string[],
	cfg: Pick<AuditConfig, 'ignoreMembers' | 'includeBots'>,
): string[] {
	return members.filter((login) => {
		if (cfg.ignoreMembers.has(login)) return false;
		if (!cfg.includeBots && isBot(login)) return false;
		return true;
	});
}

// Returns the first ignored team a user belongs to (if any), or null. Used by
// both audits to skip members of `ignoreTeams` while logging the reason.
export function intersectsIgnored(
	userTeams: ReadonlySet<string>,
	ignoreTeams: ReadonlySet<string>,
): string | null {
	for (const t of userTeams) {
		if (ignoreTeams.has(t)) return t;
	}
	return null;
}

// Comments aren't part of contributionsCollection, so the comments-fallback
// probe only needs to fire when the user opted into either comment type.
export function wantsCommentSignal(types: ReadonlySet<InteractionType>): boolean {
	return types.has('issue-comment') || types.has('pr-comment');
}
