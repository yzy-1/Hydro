import { readFile } from 'fs/promises';
import { STATUS } from '@hydrooj/utils/lib/status';
import { TestCase } from 'hydrooj';
import checkers, { PartialFragment } from '../checkers';
import { runFlow } from '../flow';
import { del, get, runQueued } from '../sandbox';
import signals from '../signals';
import { makeFragment, NormalizedCase } from '../utils';
import { Context, ContextSubTask } from './interface';

function judgeCase(c: NormalizedCase) {
    return async (ctx: Context, ctxSubtask: ContextSubTask, runner?: Function): Promise<TestCase> => {
        const { address_space_limit, process_limit } = ctx.session.getLang(ctx.lang);
        const res = await runQueued(
            ctx.execute.execute,
            {
                stdin: { src: c.input },
                copyIn: ctx.execute.copyIn,
                filename: ctx.config.filename,
                time: c.time,
                memory: c.memory,
                cacheStdoutAndStderr: true,
                addressSpaceLimit: address_space_limit,
                processLimit: process_limit,
            },
        );
        const {
            code, signalled, time, memory, fileIds,
        } = res;
        let { status } = res;
        let message: any = '';
        let score = 0;
        let scaledScore = 0;
        let partialFragments: Record<string, PartialFragment>;
        const detail = ctx.config.detail ?? true;
        if (status === STATUS.STATUS_ACCEPTED) {
            if (time > c.time) {
                status = STATUS.STATUS_TIME_LIMIT_EXCEEDED;
            } else if (memory > c.memory * 1024) {
                status = STATUS.STATUS_MEMORY_LIMIT_EXCEEDED;
            } else {
                ({
                    status, score, scaledScore, message, fragments: partialFragments,
                } = await checkers[ctx.config.checker_type]({
                    execute: ctx.checker.execute,
                    copyIn: ctx.checker.copyIn || {},
                    input: { src: c.input },
                    output: { src: c.output },
                    user_stdout: fileIds.stdout ? { fileId: fileIds.stdout } : { content: '' },
                    user_stderr: fileIds.stderr ? { fileId: fileIds.stderr } : { content: '' },
                    score: c.score,
                    detail,
                    env: { ...ctx.env, HYDRO_TESTCASE: c.id.toString() },
                }));
            }
        } else if (status === STATUS.STATUS_RUNTIME_ERROR && code && detail) {
            if (code < 32 && signalled) message = signals[code];
            else message = { message: 'Your program returned {0}.', params: [code] };
        }
        const [infContent, ansContent] = await Promise.all([
            readFile(c.input),
            readFile(c.output),
        ]);
        const oufContent = fileIds.stdout ? await get(fileIds.stdout) : Buffer.alloc(0);

        // Fallback stream fragments
        partialFragments = {
            inf: { byteIdx: 0, dir: 'after', highlightLines: [] },
            ouf: { byteIdx: 0, dir: 'after', highlightLines: [] },
            ans: { byteIdx: 0, dir: 'after', highlightLines: [] },
            ...(partialFragments || {}),
        };

        const streamContents = { inf: infContent, ouf: oufContent, ans: ansContent };

        const fragments = Object.entries(partialFragments).reduce((acc, [streamName, p]) => {
            if (!streamContents[streamName]) {
                return acc;
            }
            acc[streamName] = makeFragment(streamContents[streamName], p.byteIdx, p.dir, p.highlightLines);
            return acc;
        }, {});

        await Promise.allSettled(Object.values(res.fileIds).map((id) => del(id)));
        if (runner && ctx.rerun && c.time <= 5000 && status === STATUS.STATUS_TIME_LIMIT_EXCEEDED) {
            ctx.rerun--;
            return await runner(ctx, ctxSubtask);
        }
        if (!ctx.request.rejudged && !ctx.analysis && [STATUS.STATUS_WRONG_ANSWER, STATUS.STATUS_RUNTIME_ERROR].includes(status)) {
            ctx.analysis = true;
            await ctx.runAnalysis(ctx.execute, { src: c.input });
        }

        return {
            id: c.id,
            subtaskId: ctxSubtask.subtask.id,
            status,
            score,
            scaledScore,
            time,
            memory,
            message,
            fragments,
        };
    };
}

export const judge = async (ctx: Context) => await runFlow(ctx, {
    compile: async () => {
        [ctx.execute, ctx.checker] = await Promise.all([
            ctx.compile(ctx.lang, ctx.code),
            ctx.compileLocalFile('checker', ctx.config.checker, ctx.config.checker_type),
        ]);
    },
    judgeCase,
});
