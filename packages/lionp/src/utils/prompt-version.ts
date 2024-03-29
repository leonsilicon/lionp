import chalk from 'chalk';
import inquirer from 'inquirer';
import isScoped from 'is-scoped';
import type { NormalizedPackageJson } from 'read-pkg-up';
import type { ReleaseType } from 'semver';

import type { LionpOptions } from '~/types/options.js';

import { printCommitLog } from './git.js';
import { getRegistryUrl, prereleaseTags } from './npm/index.js';
import { prettyVersionDiff } from './pretty-version-diff.js';
import {
	createVersion,
	getSemverIncrements,
	isPrereleaseOrIncrement,
	isValidInput,
	validate,
} from './version.js';

type PromptVersionOptions = {
	releaseDraftOnly: boolean;
	branch: string;
	repoUrl: string | undefined;
	tag: string | undefined;
	runPublish: boolean;
	version: string | undefined;
	availability: {
		isUnknown: boolean;
		isAvailable: boolean;
	};
};

export async function promptVersion(
	options: PromptVersionOptions,
	pkg: NormalizedPackageJson
): Promise<
	{
		releaseNotes?: LionpOptions['releaseNotes'];
	} & (
		| { confirm: false; version: undefined }
		| { confirm: true; version: string }
	)
> {
	const oldVersion = pkg.version;
	validate(oldVersion);

	const { repoUrl } = options;
	const pkgManager = 'pnpm';
	const registryUrl = await getRegistryUrl(pkgManager, pkg);
	const useLatestTag = !options.releaseDraftOnly;
	const releaseBranch = options.branch;

	if (options.releaseDraftOnly) {
		console.log(
			`\nCreate a release draft on GitHub for ${chalk.bold.magenta(
				pkg.name
			)} ${chalk.dim(`(current: ${oldVersion})`)}\n`
		);
	} else {
		console.log(
			`\nPublish a new version of ${chalk.bold.magenta(pkg.name)} ${chalk.dim(
				`(current: ${oldVersion})`
			)}\n`
		);
	}

	const prompts = [
		{
			type: 'list',
			name: 'version',
			message: 'Select semver increment or specify new version',
			pageSize: getSemverIncrements().length + 2,
			choices: [
				...getSemverIncrements().map((inc) => ({
					name: `${inc} 	${prettyVersionDiff(oldVersion, inc)}`,
					value: inc,
				})),
				new inquirer.Separator(),
				{
					name: 'Other (specify)',
					value: null,
				},
			],
			filter: (input: ReleaseType) =>
				isValidInput(input)
					? createVersion(oldVersion).getNewVersionFrom(input)
					: input,
		},
		{
			type: 'input',
			name: 'customVersion',
			message: 'Version',
			when: (answers: { version: string }) => !answers.version,
			filter: (input: ReleaseType) =>
				isValidInput(input)
					? createVersion(oldVersion).getNewVersionFrom(input)
					: input,
			validate(input: string) {
				if (!isValidInput(input)) {
					return 'Please specify a valid semver, for example, `1.2.3`. See https://semver.org';
				}

				if (createVersion(oldVersion).isLowerThanOrEqualTo(input)) {
					return `Version must be greater than ${oldVersion}`;
				}

				return true;
			},
		},
		{
			type: 'list',
			name: 'tag',
			message: 'How should this pre-release version be tagged in npm?',
			when: (answers: { customVersion: string; version: string }) =>
				(isPrereleaseOrIncrement(answers.customVersion) ||
					isPrereleaseOrIncrement(answers.version)) &&
				options.tag !== undefined,
			async choices() {
				const existingPrereleaseTags = await prereleaseTags(pkg.name);

				return [
					...existingPrereleaseTags,
					new inquirer.Separator(),
					{
						name: 'Other (specify)',
						value: null,
					},
				];
			},
		},
		{
			type: 'input',
			name: 'customTag',
			message: 'Tag',
			when: (answers: { customVersion: string; version: string }) =>
				(isPrereleaseOrIncrement(answers.customVersion) ||
					isPrereleaseOrIncrement(answers.version)) &&
				options.tag !== undefined,
			validate(input: string) {
				if (input.length === 0) {
					return 'Please specify a tag, for example, `next`.';
				}

				if (input.toLowerCase() === 'latest') {
					return "It's not possible to publish pre-releases under the `latest` tag. Please specify something else, for example, `next`.";
				}

				return true;
			},
		},
	];

	const { hasCommits, hasUnreleasedCommits, releaseNotes } =
		await printCommitLog(repoUrl, registryUrl, useLatestTag, releaseBranch);

	if (hasUnreleasedCommits && options.releaseDraftOnly) {
		const answers = await inquirer.prompt<{ confirm: boolean }>([
			{
				type: 'confirm',
				name: 'confirm',
				message:
					"Unreleased commits found. They won't be included in the release draft. Continue?",
				default: false,
			},
		]);

		if (!answers.confirm) {
			return {
				version: undefined,
				confirm: false,
			};
		}
	}

	// If the version is already specified, no need to prompt for it
	if (options.version !== undefined) {
		return {
			...options,
			version: options.version,
			confirm: true,
			releaseNotes,
		};
	}

	if (!hasCommits) {
		const answers = await inquirer.prompt<{ confirm: boolean }>([
			{
				type: 'confirm',
				name: 'confirm',
				message: 'No commits found since previous release, continue?',
				default: false,
			},
		]);

		if (!answers.confirm) {
			return {
				version: undefined,
				confirm: false,
			};
		}
	}

	if (options.availability.isUnknown) {
		const answers = await inquirer.prompt<{ confirm: boolean }>([
			{
				type: 'confirm',
				name: 'confirm',
				when: isScoped(pkg.name) && options.runPublish,
				message: `Failed to check availability of scoped repo name ${chalk.bold.magenta(
					pkg.name
				)}. Do you want to try and publish it anyway?`,
				default: false,
			},
		]);

		if (!answers.confirm) {
			return {
				version: undefined,
				confirm: false,
			};
		}
	}

	const answers = await inquirer.prompt(prompts);

	return {
		...options,
		version: answers.version || answers.customVersion,
		confirm: true,
	};
}
