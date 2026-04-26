import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import { parseInputs } from './inputs.js';

vi.mock('@actions/core', () => ({
	getInput: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock('@actions/github', () => ({
	context: {
		get repo() {
			return { owner: 'ctx-owner', repo: 'ctx-repo' };
		},
	},
}));

const FROZEN_NOW = new Date('2026-04-26T12:00:00.000Z');

function setInputs(inputs: Record<string, string>): void {
	vi.mocked(core.getInput).mockImplementation((name) => inputs[name] ?? '');
}

const minimal = { org: 'acme', token: 'ghp_x' };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FROZEN_NOW);
	process.env.GITHUB_REPOSITORY = 'ctx-owner/ctx-repo';
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.GITHUB_REPOSITORY;
});

describe('parseInputs', () => {
	it('returns a frozen config with sensible defaults', () => {
		setInputs(minimal);
		const cfg = parseInputs();
		expect(cfg.org).toBe('acme');
		expect(cfg.token).toBe('ghp_x');
		expect(cfg.reportRepo).toEqual({ owner: 'ctx-owner', repo: 'ctx-repo' });
		expect(cfg.inactivityDays).toBe(90);
		expect(cfg.dryRun).toBe(false);
		expect(cfg.includeBots).toBe(false);
		expect(cfg.includeOutsideCollaborators).toBe(false);
		expect(cfg.concurrency).toBe(5);
		expect(cfg.teamMap).toEqual({});
		expect(cfg.ignoreTeams).toEqual(new Set());
		expect(Array.from(cfg.interactionTypes).sort()).toEqual(['commit', 'issue', 'pr', 'pr-review']);
		expect(Object.isFrozen(cfg)).toBe(true);
	});

	it('computes since as now - inactivityDays in UTC', () => {
		setInputs({ ...minimal, 'inactivity-days': '30' });
		const cfg = parseInputs();
		expect(cfg.now).toBe('2026-04-26T12:00:00.000Z');
		expect(cfg.since).toBe('2026-03-27T12:00:00.000Z');
	});

	it('throws when org is missing', () => {
		setInputs({ token: 'x' });
		expect(() => parseInputs()).toThrow(/org/);
	});

	it('throws when token is missing', () => {
		setInputs({ org: 'acme' });
		expect(() => parseInputs()).toThrow(/token/);
	});

	it('throws on negative or zero inactivity-days', () => {
		setInputs({ ...minimal, 'inactivity-days': '0' });
		expect(() => parseInputs()).toThrow(/inactivity-days/);
		setInputs({ ...minimal, 'inactivity-days': '-5' });
		expect(() => parseInputs()).toThrow(/inactivity-days/);
		setInputs({ ...minimal, 'inactivity-days': 'abc' });
		expect(() => parseInputs()).toThrow(/inactivity-days/);
	});

	it('parses report-repo into owner/repo', () => {
		setInputs({ ...minimal, 'report-repo': 'acme/audits' });
		expect(parseInputs().reportRepo).toEqual({ owner: 'acme', repo: 'audits' });
	});

	it('throws on malformed report-repo', () => {
		setInputs({ ...minimal, 'report-repo': 'no-slash' });
		expect(() => parseInputs()).toThrow(/report-repo/);
	});

	it('throws when report-repo missing and not running inside Actions', () => {
		delete process.env.GITHUB_REPOSITORY;
		setInputs(minimal);
		expect(() => parseInputs()).toThrow(/report-repo/);
	});

	it('parses team-map JSON into record of owner/repo', () => {
		setInputs({
			...minimal,
			'team-map': '{"infra":"acme/infra-board","data":"acme/data-board"}',
		});
		expect(parseInputs().teamMap).toEqual({
			infra: { owner: 'acme', repo: 'infra-board' },
			data: { owner: 'acme', repo: 'data-board' },
		});
	});

	it('throws on malformed team-map JSON', () => {
		setInputs({ ...minimal, 'team-map': '{not-json' });
		expect(() => parseInputs()).toThrow(/team-map/);
	});

	it('throws when team-map is an array', () => {
		setInputs({ ...minimal, 'team-map': '["a","b"]' });
		expect(() => parseInputs()).toThrow(/team-map/);
	});

	it('throws when team-map value is not "owner/repo"', () => {
		setInputs({ ...minimal, 'team-map': '{"infra":"missing-slash"}' });
		expect(() => parseInputs()).toThrow(/team-map/);
	});

	it('parses CSV ignore lists, trimming whitespace', () => {
		setInputs({
			...minimal,
			'ignore-repositories': 'acme/legacy , acme/private-fork',
			'ignore-members': 'alice ,bob ,  carol',
		});
		const cfg = parseInputs();
		expect(Array.from(cfg.ignoreRepositories).sort()).toEqual(['acme/legacy', 'acme/private-fork']);
		expect(Array.from(cfg.ignoreMembers).sort()).toEqual(['alice', 'bob', 'carol']);
	});

	it('throws when ignore-repositories has malformed entry', () => {
		setInputs({ ...minimal, 'ignore-repositories': 'acme/legacy,nope' });
		expect(() => parseInputs()).toThrow(/ignore-repositories/);
	});

	it('rejects unknown interaction-types', () => {
		setInputs({ ...minimal, 'interaction-types': 'commit,wave' });
		expect(() => parseInputs()).toThrow(/interaction-types/);
	});

	it('rejects empty interaction-types', () => {
		setInputs({ ...minimal, 'interaction-types': '   ' });
		expect(() => parseInputs()).toThrow(/interaction-types/);
	});

	it('parses ignore-teams as a CSV set', () => {
		setInputs({ ...minimal, 'ignore-teams': 'alumni , owners' });
		expect([...parseInputs().ignoreTeams].sort()).toEqual(['alumni', 'owners']);
	});

	it('warns when pr-review is in interaction-types', () => {
		setInputs({ ...minimal, 'interaction-types': 'commit,pr-review' });
		parseInputs();
		expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/pr-review/));
	});

	it('warns when comments are in interaction-types', () => {
		setInputs({ ...minimal, 'interaction-types': 'commit,issue-comment' });
		parseInputs();
		expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/comments/));
	});

	it('warns when concurrency is high', () => {
		setInputs({ ...minimal, concurrency: '20' });
		parseInputs();
		expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/concurrency=20/));
	});

	it('warns when include-outside-collaborators is true', () => {
		setInputs({ ...minimal, 'include-outside-collaborators': 'true' });
		parseInputs();
		expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/outside collaborators/));
	});

	it('coerces dry-run, include-bots, include-outside-collaborators booleans', () => {
		setInputs({
			...minimal,
			'dry-run': 'true',
			'include-bots': 'TRUE',
			'include-outside-collaborators': 'False',
		});
		const cfg = parseInputs();
		expect(cfg.dryRun).toBe(true);
		expect(cfg.includeBots).toBe(true);
		expect(cfg.includeOutsideCollaborators).toBe(false);
	});

	it('throws when concurrency is not a positive integer', () => {
		setInputs({ ...minimal, concurrency: '0' });
		expect(() => parseInputs()).toThrow(/concurrency/);
		setInputs({ ...minimal, concurrency: '-3' });
		expect(() => parseInputs()).toThrow(/concurrency/);
	});
});
