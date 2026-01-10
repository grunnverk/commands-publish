#!/usr/bin/env node
import { Formatter, Model } from '@riotprompt/riotprompt';
import 'dotenv/config';
import type { ChatCompletionMessageParam } from 'openai/resources';
import { getDefaultFromRef, getCurrentBranch, safeJsonParse } from '@eldrforge/git-tools';
import {
    Config,
    Log,
    Diff,
    DEFAULT_EXCLUDED_PATTERNS,
    DEFAULT_TO_COMMIT_ALIAS,
    DEFAULT_OUTPUT_DIRECTORY,
    DEFAULT_MAX_DIFF_BYTES,
    improveContentWithLLM,
    toAIConfig,
    createStorageAdapter,
    createLoggerAdapter,
    getDryRunLogger,
    getOutputPath,
    getTimestampedRequestFilename,
    getTimestampedResponseFilename,
    getTimestampedReleaseNotesFilename,
    validateReleaseSummary,
    ReleaseSummary,
    filterContent,
    type LLMImprovementConfig,
} from '@eldrforge/core';
import {
    createCompletionWithRetry,
    getUserChoice,
    editContentInEditor,
    getLLMFeedbackInEditor,
    requireTTY,
    STANDARD_CHOICES,
    ReleaseContext,
    runAgenticRelease,
    generateReflectionReport,
    createReleasePrompt,
} from '@eldrforge/ai-service';
import { createStorage } from '@eldrforge/shared';
import * as GitHub from '@eldrforge/github-tools';

// Helper function to read context files
async function readContextFiles(contextFiles: string[] | undefined, logger: any): Promise<string> {
    if (!contextFiles || contextFiles.length === 0) {
        return '';
    }

    const storage = createStorage();
    const contextParts: string[] = [];

    for (const filePath of contextFiles) {
        try {
            const content = await storage.readFile(filePath, 'utf8');
            contextParts.push(`## Context from ${filePath}\n\n${content}\n`);
            logger.debug(`Read context from file: ${filePath}`);
        } catch (error: any) {
            logger.warn(`Failed to read context file ${filePath}: ${error.message}`);
        }
    }

    return contextParts.join('\n---\n\n');
}

// Helper function to edit release notes using editor
async function editReleaseNotesInteractively(releaseSummary: ReleaseSummary): Promise<ReleaseSummary> {
    const templateLines = [
        '# Edit your release notes below. Lines starting with "#" will be ignored.',
        '# The first line is the title, everything else is the body.',
        '# Save and close the editor when you are done.'
    ];

    const content = `${releaseSummary.title}\n\n${releaseSummary.body}`;
    const result = await editContentInEditor(content, templateLines, '.md');

    const lines = result.content.split('\n');
    const title = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();

    return { title, body };
}

// Helper function to improve release notes using LLM
async function improveReleaseNotesWithLLM(
    releaseSummary: ReleaseSummary,
    runConfig: Config,
    promptConfig: any,
    promptContext: any,
    outputDirectory: string,
    logContent: string,
    diffContent: string
): Promise<ReleaseSummary> {
    // Get user feedback on what to improve using the editor
    const releaseNotesContent = `${releaseSummary.title}\n\n${releaseSummary.body}`;
    const userFeedback = await getLLMFeedbackInEditor('release notes', releaseNotesContent);

    const improvementConfig: LLMImprovementConfig = {
        contentType: 'release notes',
        createImprovedPrompt: async (promptConfig, currentSummary, promptContext) => {
            const improvementPromptContent = {
                logContent: logContent,
                diffContent: diffContent,
                releaseFocus: `Please improve these release notes based on the user's feedback: "${userFeedback}".

Current release notes:
Title: "${currentSummary.title}"
Body: "${currentSummary.body}"

Please revise the release notes according to the user's feedback while maintaining accuracy and following good release note practices.`,
            };
            const promptResult = await createReleasePrompt(promptConfig, improvementPromptContent, promptContext);
            // Format the prompt into a proper request with messages
            const aiConfig = toAIConfig(runConfig);
            const modelToUse = aiConfig.commands?.release?.model || aiConfig.model || 'gpt-4o-mini';
            return Formatter.create({ logger: getDryRunLogger(false) }).formatPrompt(modelToUse as Model, promptResult.prompt);
        },
        callLLM: async (request, runConfig, outputDirectory) => {
            const aiConfig = toAIConfig(runConfig);
            const aiStorageAdapter = createStorageAdapter(outputDirectory);
            const aiLogger = createLoggerAdapter(false);
            const modelToUse = aiConfig.commands?.release?.model || aiConfig.model || 'gpt-4o-mini';
            const openaiReasoning = aiConfig.commands?.release?.reasoning || aiConfig.reasoning;
            return await createCompletionWithRetry(
                request.messages as ChatCompletionMessageParam[],
                {
                    model: modelToUse,
                    openaiReasoning,
                    responseFormat: { type: 'json_object' },
                    debug: runConfig.debug,
                    debugRequestFile: getOutputPath(outputDirectory, getTimestampedRequestFilename('release-improve')),
                    debugResponseFile: getOutputPath(outputDirectory, getTimestampedResponseFilename('release-improve')),
                    storage: aiStorageAdapter,
                    logger: aiLogger,
                }
            );
        },
        processResponse: (response: any) => {
            return validateReleaseSummary(response);
        }
    };

    return await improveContentWithLLM(
        releaseSummary,
        runConfig,
        promptConfig,
        promptContext,
        outputDirectory,
        improvementConfig
    );
}

// Helper function to generate self-reflection output for release notes using observability module
async function generateSelfReflection(
    agenticResult: any,
    outputDirectory: string,
    storage: any,
    logger: any
): Promise<void> {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
        const reflectionPath = getOutputPath(outputDirectory, `agentic-reflection-release-${timestamp}.md`);

        // Use new observability reflection generator
        const report = await generateReflectionReport({
            iterations: agenticResult.iterations || 0,
            toolCallsExecuted: agenticResult.toolCallsExecuted || 0,
            maxIterations: agenticResult.maxIterations || 30,
            toolMetrics: agenticResult.toolMetrics || [],
            conversationHistory: agenticResult.conversationHistory || [],
            releaseNotes: agenticResult.releaseNotes,
            logger
        });

        // Save the report to output directory
        await storage.writeFile(reflectionPath, report, 'utf8');

        logger.info('');
        logger.info('═'.repeat(80));
        logger.info('📊 SELF-REFLECTION REPORT GENERATED');
        logger.info('═'.repeat(80));
        logger.info('');
        logger.info('📁 Location: %s', reflectionPath);
        logger.info('');
        logger.info('📈 Report Summary:');
        const iterations = agenticResult.iterations || 0;
        const toolCalls = agenticResult.toolCallsExecuted || 0;
        const uniqueTools = new Set((agenticResult.toolMetrics || []).map((m: any) => m.name)).size;
        logger.info(`   • ${iterations} iterations completed`);
        logger.info(`   • ${toolCalls} tool calls executed`);
        logger.info(`   • ${uniqueTools} unique tools used`);
        logger.info('');
        logger.info('💡 Use this report to:');
        logger.info('   • Understand which tools were most effective');
        logger.info('   • Identify performance bottlenecks');
        logger.info('   • Optimize tool selection and usage patterns');
        logger.info('   • Improve agentic release notes generation');
        logger.info('');
        logger.info('═'.repeat(80));
    } catch (error: any) {
        logger.warn('Failed to generate self-reflection report: %s', error.message);
    }
}

// Interactive feedback loop for release notes
async function handleInteractiveReleaseFeedback(
    releaseSummary: ReleaseSummary,
    runConfig: Config,
    promptConfig: any,
    promptContext: any,
    outputDirectory: string,
    storage: any,
    logContent: string,
    diffContent: string
): Promise<{ action: 'confirm' | 'skip', finalSummary: ReleaseSummary }> {
    const logger = getDryRunLogger(false);
    let currentSummary = releaseSummary;

    while (true) {
        // Display the current release notes
        logger.info('\nRELEASE_NOTES_GENERATED: Generated release notes from AI | Title Length: ' + currentSummary.title.length + ' | Body Length: ' + currentSummary.body.length);
        logger.info('─'.repeat(50));
        logger.info('RELEASE_NOTES_TITLE: %s', currentSummary.title);
        logger.info('');
        logger.info('RELEASE_NOTES_BODY: Release notes content:');
        logger.info(currentSummary.body);
        logger.info('─'.repeat(50));

        // Get user choice
        const userChoice = await getUserChoice(
            '\nWhat would you like to do with these release notes?',
            [
                STANDARD_CHOICES.CONFIRM,
                STANDARD_CHOICES.EDIT,
                STANDARD_CHOICES.SKIP,
                STANDARD_CHOICES.IMPROVE
            ],
            {
                nonTtyErrorSuggestions: ['Use --dry-run to see the generated content without interaction']
            }
        );

        switch (userChoice) {
            case 'c':
                return { action: 'confirm', finalSummary: currentSummary };

            case 'e':
                try {
                    currentSummary = await editReleaseNotesInteractively(currentSummary);
                } catch (error: any) {
                    logger.error(`RELEASE_NOTES_EDIT_FAILED: Unable to edit release notes | Error: ${error.message} | Impact: Using original notes`);
                    // Continue the loop to show options again
                }
                break;

            case 's':
                return { action: 'skip', finalSummary: currentSummary };

            case 'i':
                try {
                    currentSummary = await improveReleaseNotesWithLLM(
                        currentSummary,
                        runConfig,
                        promptConfig,
                        promptContext,
                        outputDirectory,
                        logContent,
                        diffContent
                    );
                } catch (error: any) {
                    logger.error(`RELEASE_NOTES_IMPROVE_FAILED: Unable to improve release notes | Error: ${error.message} | Impact: Using current version`);
                    // Continue the loop to show options again
                }
                break;

            default:
                // This shouldn't happen, but continue the loop
                break;
        }
    }
}

export const execute = async (runConfig: Config): Promise<ReleaseSummary> => {
    const isDryRun = runConfig.dryRun || false;
    const logger = getDryRunLogger(isDryRun);

    // Get current branch to help determine best tag comparison
    const currentBranch = runConfig.release?.currentBranch || await getCurrentBranch();

    // Resolve the from reference with fallback logic if not explicitly provided
    const fromRef = runConfig.release?.from ?? await getDefaultFromRef(
        runConfig.release?.fromMain || false,
        currentBranch
    );
    const toRef = runConfig.release?.to ?? DEFAULT_TO_COMMIT_ALIAS;

    logger.debug(`Using git references: from=${fromRef}, to=${toRef}`);

    const log = await Log.create({
        from: fromRef,
        to: toRef,
        limit: runConfig.release?.messageLimit
    });
    let logContent = '';

    const maxDiffBytes = runConfig.release?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
    const diff = await Diff.create({
        from: fromRef,
        to: toRef,
        excludedPatterns: runConfig.excludedPatterns ?? DEFAULT_EXCLUDED_PATTERNS,
        maxDiffBytes
    });
    let diffContent = '';

    diffContent = await diff.get();
    logContent = await log.get();

    const promptConfig = {
        overridePaths: runConfig.discoveredConfigDirs || [],
        overrides: runConfig.overrides || false,
    };
    // Helper function to determine versions for milestone lookup
    const determineVersionsForMilestones = async (): Promise<string[]> => {
        const versions: string[] = [];

        // Get current package.json version to determine likely release version
        try {
            const storage = createStorage();
            const packageJsonContents = await storage.readFile('package.json', 'utf-8');
            const packageJson = safeJsonParse(packageJsonContents, 'package.json');
            const currentVersion = packageJson.version;

            if (currentVersion) {
                // If it's a dev version (e.g., "0.1.1-dev.0"), extract base version
                if (currentVersion.includes('-dev.')) {
                    const baseVersion = currentVersion.split('-')[0];
                    versions.push(baseVersion);
                    logger.debug(`Detected dev version ${currentVersion}, will check milestone for ${baseVersion}`);
                } else {
                    // Use current version as-is
                    versions.push(currentVersion);
                    logger.debug(`Using current version ${currentVersion} for milestone lookup`);
                }
            }
        } catch (error: any) {
            logger.debug(`Failed to read package.json version: ${error.message}`);
        }

        // Handle edge case: if publish targetVersion is different from current version
        if (runConfig.publish?.targetVersion &&
            runConfig.publish.targetVersion !== 'patch' &&
            runConfig.publish.targetVersion !== 'minor' &&
            runConfig.publish.targetVersion !== 'major') {

            const targetVersion = runConfig.publish.targetVersion;
            if (!versions.includes(targetVersion)) {
                versions.push(targetVersion);
                logger.debug(`Added target version ${targetVersion} for milestone lookup`);
            }
        }

        return versions;
    };

    // Get milestone issues if enabled
    let milestoneIssuesContent = '';
    const milestonesEnabled = !runConfig.release?.noMilestones;

    if (milestonesEnabled) {
        logger.info('RELEASE_MILESTONE_CHECK: Checking for milestone issues | Purpose: Include in release notes | Source: GitHub milestones');
        const versions = await determineVersionsForMilestones();

        if (versions.length > 0) {
            milestoneIssuesContent = await GitHub.getMilestoneIssuesForRelease(versions, 50000);
            if (milestoneIssuesContent) {
                logger.info('RELEASE_MILESTONE_INCLUDED: Incorporated milestone issues into context | Count: ' + (milestoneIssuesContent?.length || 0) + ' | Purpose: Enrich release notes');
            } else {
                logger.debug('No milestone issues found to incorporate');
            }
        } else {
            logger.debug('No versions determined for milestone lookup');
        }
    } else {
        logger.debug('Milestone integration disabled via --no-milestones');
    }

    // Always ensure output directory exists for request/response files
    const outputDirectory = runConfig.outputDirectory || DEFAULT_OUTPUT_DIRECTORY;
    const storage = createStorage();
    await storage.ensureDirectory(outputDirectory);

    // Create adapters for ai-service
    const aiConfig = toAIConfig(runConfig);
    const aiStorageAdapter = createStorageAdapter(outputDirectory);
    const aiLogger = createLoggerAdapter(isDryRun);

    // Read context from files if provided
    const contextFromFiles = await readContextFiles(runConfig.release?.contextFiles, logger);

    // Combine file context with existing context
    const combinedContext = [
        runConfig.release?.context,
        contextFromFiles
    ].filter(Boolean).join('\n\n---\n\n');

    // Run agentic release notes generation
    const agenticResult = await runAgenticRelease({
        fromRef,
        toRef,
        logContent,
        diffContent,
        milestoneIssues: milestoneIssuesContent,
        releaseFocus: runConfig.release?.focus,
        userContext: combinedContext || undefined,
        model: aiConfig.commands?.release?.model || aiConfig.model || 'gpt-4o',
        maxIterations: runConfig.release?.maxAgenticIterations || 30,
        debug: runConfig.debug,
        debugRequestFile: getOutputPath(outputDirectory, getTimestampedRequestFilename('release')),
        debugResponseFile: getOutputPath(outputDirectory, getTimestampedResponseFilename('release')),
        storage: aiStorageAdapter,
        logger: aiLogger,
        openaiReasoning: aiConfig.commands?.release?.reasoning || aiConfig.reasoning,
    });

    const iterations = agenticResult.iterations || 0;
    const toolCalls = agenticResult.toolCallsExecuted || 0;
    logger.info(`🔍 Analysis complete: ${iterations} iterations, ${toolCalls} tool calls`);

    // Generate self-reflection output if enabled
    if (runConfig.release?.selfReflection) {
        await generateSelfReflection(agenticResult, outputDirectory, storage, logger);
    }

    // Apply stop-context filtering to release notes
    const titleFilterResult = filterContent(agenticResult.releaseNotes.title, runConfig.stopContext);
    const bodyFilterResult = filterContent(agenticResult.releaseNotes.body, runConfig.stopContext);
    let releaseSummary: ReleaseSummary = {
        title: titleFilterResult.filtered,
        body: bodyFilterResult.filtered,
    };

    // Handle interactive mode
    if (runConfig.release?.interactive && !isDryRun) {
        requireTTY('Interactive mode requires a terminal. Use --dry-run instead.');

        const interactivePromptContext: ReleaseContext = {
            context: combinedContext || undefined,
            directories: runConfig.contextDirectories,
        };

        const interactiveResult = await handleInteractiveReleaseFeedback(
            releaseSummary,
            runConfig,
            promptConfig,
            interactivePromptContext,
            outputDirectory,
            storage,
            logContent,
            diffContent
        );

        if (interactiveResult.action === 'skip') {
            logger.info('RELEASE_ABORTED: Release notes generation aborted by user | Reason: User choice | Status: cancelled');
        } else {
            logger.info('RELEASE_FINALIZED: Release notes finalized and accepted | Status: ready | Next: Create release or save');
        }

        releaseSummary = interactiveResult.finalSummary;
    }

    // Save timestamped copy of release notes to output directory
    try {
        const timestampedFilename = getTimestampedReleaseNotesFilename();
        const outputPath = getOutputPath(outputDirectory, timestampedFilename);

        // Format the release notes as markdown
        const releaseNotesContent = `# ${releaseSummary.title}\n\n${releaseSummary.body}`;

        await storage.writeFile(outputPath, releaseNotesContent, 'utf-8');
        logger.debug('Saved timestamped release notes: %s', outputPath);
    } catch (error: any) {
        logger.warn('RELEASE_SAVE_FAILED: Failed to save timestamped release notes | Error: %s | Impact: Notes not persisted to file', error.message);
    }

    if (isDryRun) {
        logger.info('RELEASE_SUMMARY_COMPLETE: Generated release summary successfully | Status: completed');
        logger.info('RELEASE_SUMMARY_TITLE: %s', releaseSummary.title);
        logger.info('RELEASE_SUMMARY_BODY: %s', releaseSummary.body);
    }

    return releaseSummary;
}
