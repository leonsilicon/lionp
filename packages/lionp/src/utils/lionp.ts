import * as fs from 'node:fs';
import * as path from 'node:path';

import exitHook from 'async-exit-hook';
import { deleteAsync } from 'del';
import type { ExecaError } from 'execa';
import { execa } from 'execa';
import hostedGitInfo from 'hosted-git-info';
import { Listr } from 'listr2';
import logSymbols from 'log-symbols';
import onetime from 'onetime';
import { packageDirectorySync } from 'pkg-dir';
import { readPackageUp } from 'read-pkg-up';

import type { LionpOptions } from '~/types/options.js';
import { createVersion } from '~/utils/version.js';

import * as git from './git.js';
import { gitTasks } from './git-tasks.js';
import * as npm from './npm/index.js';
import { enable2fa, getEnable2faArgs } from './npm/index.js';
import { getPackagePublishArguments, publish } from './npm/publish.js';
import { prerequisiteTasks } from './prerequisite-tasks.js';
import { releaseTaskHelper } from './release-task-helper.js';
import { getTagVersionPrefix, readPkg } from './util.js';

export async function lionp(options: LionpOptions) {
	const pkg = readPkg();
	const {
		version,
		testScript,
		buildScript,
		tests: runTests,
		cleanup: runCleanup,
	} = options;
	const rootDir = packageDirectorySync();
	const pkgManager = 'pnpm';
	const pkgManagerName = 'pnpm';
	const hasLockFile = fs.existsSync(path.resolve(rootDir!, 'pnpm-lock.yaml'));
	const isOnGitHub =
		options.repoUrl === undefined
			? false
			: hostedGitInfo.fromUrl(options.repoUrl)?.type === 'github';

	const testCommand = [
		pkg.scripts?.test === undefined ? 'exec' : 'run',
		testScript,
	];
	const buildCommand = [
		pkg.scripts?.build === undefined ? 'exec' : 'run',
		buildScript,
	];
	let publishStatus = 'UNKNOWN';
	let pushedObjects: { pushed: string; reason: string } | undefined;
	const isRepoRoot = fs.existsSync(path.resolve(rootDir!, '.git'));

	const rollback = onetime(async () => {
		console.log('\nPublish failed. Rolling back to the previous state…');

		try {
			const tagVersionPrefix = await getTagVersionPrefix();

			const latestTag = await git.latestTag();
			const versionInLatestTag = latestTag.slice(tagVersionPrefix.length);

			// Verify that the package's version has been bumped before deleting the last tag and commit.
			if (
				versionInLatestTag === readPkg().version &&
				versionInLatestTag !== pkg.version
			) {
				await git.deleteTag(latestTag);
				await git.removeLastCommit();
			}

			console.log(
				'Successfully rolled back the project to its previous state.'
			);
		} catch (error: unknown) {
			const err = String(error);
			console.log(`Couldn't roll back because of the following error:\n${err}`);
		}
	});

	// The default parameter is a workaround for https://github.com/Tapppi/async-exit-hook/issues/9
	exitHook(
		(
			callback = () => {
				/* Noop */
			}
		) => {
			if (options.preview) {
				callback();
			} else if (publishStatus === 'FAILED') {
				(async () => {
					await rollback();
					callback();
				})();
			} else if (publishStatus === 'SUCCESS') {
				callback();
			} else {
				console.log('\nAborted!');
				callback();
			}
		}
	);

	const tasks = new Listr<{ otp: string }>(
		[
			{
				title: 'Prerequisite check',
				enabled: () => options.runPublish,
				task: () => prerequisiteTasks(version, pkg, options),
			},
			{
				title: 'Git',
				task: () => gitTasks(options),
			},
		],
		{
			rendererOptions: {
				showSubtasks: false,
			},
		}
	);

	if (runCleanup) {
		tasks.add([
			{
				title: 'Cleanup',
				enabled: () => !hasLockFile,
				task: async () => deleteAsync('node_modules'),
			},
			{
				title: 'Installing dependencies using pnpm',
				async task() {
					await execa('pnpm', [
						'install',
						'--frozen-lockfile',
						'--production=false',
					]);
				},
			},
		]);
	}

	if (runTests) {
		tasks.add([
			{
				title: 'Running tests using pnpm',
				async task() {
					await execa('pnpm', testCommand);
				},
			},
		]);
	}

	tasks.add([
		{
			title: 'Bumping version using pnpm',
			skip() {
				if (options.preview) {
					let previewText = `[Preview] Command not executed: npm version ${version}`;

					if (options.message) {
						previewText += ` --message '${options.message.replace(
							/%s/g,
							version
						)}'`;
					}

					return `${previewText}.`;
				}

				return false;
			},
			async task() {
				// We'll tag the version manually
				const args = ['version', version, '--no-git-tag-version'];

				if (options.message) {
					args.push('--message', options.message);
				}

				const newVersion = createVersion(pkg.version).getNewVersionFrom(
					options.version
				)!;

				await execa('pnpm', args);
				await execa('git', ['add', 'package.json']);
				await execa('git', ['commit', '-m', newVersion]);

				// If the folder is a .git folder, then create the tag
				if (isRepoRoot) {
					await execa('git', ['tag', newVersion]);
				}
			},
		},
	]);

	if (options.runBuild) {
		tasks.add([
			{
				title: 'Running build using pnpm',
				async task() {
					try {
						await execa('pnpm', buildCommand);
					} catch (error: unknown) {
						const err = error as ExecaError;
						await rollback();
						throw new Error(
							`Error: Build failed: ${err.message}; the project was rolled back to its previous state.`
						);
					}
				},
			},
		]);
	}

	if (options.runPublish) {
		tasks.add([
			{
				title: `Publishing package using ${pkgManagerName}`,
				skip() {
					if (options.preview) {
						const args = getPackagePublishArguments(options);
						return `[Preview] Command not executed: ${pkgManager} ${args.join(
							' '
						)}.`;
					}

					return false;
				},
				async task(context, task) {
					let hasError = false;

					try {
						await publish(context, pkgManager, task, options);
					} catch (error: unknown) {
						const err = error as ExecaError;
						hasError = true;
						await rollback();
						throw new Error(
							`Error publishing package:\n${err.message}\n\nThe project was rolled back to its previous state.`
						);
					}

					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					publishStatus = hasError ? 'FAILED' : 'SUCCESS';
				},
			},
		]);

		const isExternalRegistry = npm.isExternalRegistry(pkg);
		if (
			options['2fa'] &&
			options.availability.isAvailable &&
			!options.availability.isUnknown &&
			!pkg.private &&
			!isExternalRegistry
		) {
			tasks.add([
				{
					title: 'Enabling two-factor authentication',
					skip(context) {
						if (options.preview) {
							const args = getEnable2faArgs(pkg.name, {
								...options,
								otp: context.otp,
							});
							return `[Preview] Command not executed: npm ${args.join(' ')}.`;
						}

						return false;
					},
					task: async (context, task) =>
						enable2fa(task, pkg.name, { otp: context.otp }),
				},
			]);
		}
	} else {
		publishStatus = 'SUCCESS';
	}

	tasks.add({
		title: 'Pushing tags',
		async skip() {
			if (!(await git.hasUpstream())) {
				return 'Upstream branch not found; not pushing.';
			}

			if (options.preview) {
				return '[Preview] Command not executed: git push --follow-tags.';
			}

			if (publishStatus === 'FAILED' && options.runPublish) {
				return "Couldn't publish package to npm; not pushing.";
			}

			return false;
		},
		async task() {
			pushedObjects = await git.pushGraceful(isOnGitHub);
		},
	});

	if (options.releaseDraft) {
		tasks.add({
			title: 'Creating release draft on GitHub',
			enabled: () => isOnGitHub,
			skip() {
				if (options.preview) {
					return '[Preview] GitHub Releases draft will not be opened in preview mode.';
				}

				return false;
			},
			task: async () => releaseTaskHelper(options, pkg),
		});
	}

	await tasks.run();

	if (pushedObjects) {
		console.error(`\n${logSymbols.error} ${pushedObjects.reason}`);
	}

	const { packageJson: newPkg } = (await readPackageUp())!;

	return newPkg;
}
