import type { AuditConfig } from './types.js';

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
