const coerceScore = (value) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
        return 0;
    }
    return Math.max(0, Math.min(1, num));
};
const buildJudgePrompt = (input) => {
    const context = (input.context ?? [])
        .map((snippet, index) => `Context ${index + 1}:\n${snippet.trim().replace(/\s+/g, ' ')}`)
        .join('\n\n');
    const expectedAnswer = input.expectedAnswer?.trim()
        ? input.expectedAnswer.trim()
        : 'Not provided.';
    const acceptanceRule = input.acceptanceRule?.trim()
        ? input.acceptanceRule.trim()
        : 'Use best judgment based on correctness, completeness, and factual alignment with the provided context.';
    const contextSection = context ? context : 'No retrieval context was supplied.';
    const instructions = [
        'You are an impartial evaluator assessing answers produced by a retrieval-augmented generation (RAG) system.',
        'Use the question, expected answer, acceptance criteria, and retrieved context to decide whether the answer should be accepted.',
        'Return a JSON object with the following keys:',
        '- verdict: "pass" if the answer satisfies the acceptance criteria, otherwise "review".',
        '- relevance: score between 0 and 1 measuring how directly the answer addresses the question.',
        '- context_precision: score between 0 and 1 measuring how well the answer is supported by the provided context snippets.',
        '- groundedness: score between 0 and 1 measuring factual agreement with the context.',
        '- missing_criteria: array of unmet acceptance criteria or factual gaps (may be empty).',
        '- rationale: short explanation (2 sentences max).',
        'Respond with JSON only.',
    ].join(' ');
    return [
        {
            role: 'system',
            content: instructions,
        },
        {
            role: 'user',
            content: [
                `Question: ${input.question.trim()}`,
                `Expected Answer: ${expectedAnswer}`,
                `Acceptance Criteria: ${acceptanceRule}`,
                `Model Answer: ${input.answer.trim() || '(empty answer supplied)'}`,
                'Retrieved Context:',
                contextSection,
            ].join('\n\n'),
        },
    ];
};
const parseJudgeResponse = (payload) => {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Judge response was not an object.');
    }
    const verdictRaw = payload.verdict;
    const verdict = verdictRaw === 'pass' ? 'pass' : 'review';
    const relevance = coerceScore(payload.relevance);
    const contextPrecision = coerceScore(payload.context_precision);
    const groundedness = coerceScore(payload.groundedness);
    const rationale = typeof payload.rationale === 'string'
        ? payload.rationale.trim()
        : 'Evaluation failed. Please review manually.';
    const missingCriteriaRaw = payload.missing_criteria;
    const missingCriteria = Array.isArray(missingCriteriaRaw)
        ? missingCriteriaRaw
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter(Boolean)
        : [];
    return {
        verdict,
        rationale,
        missingCriteria,
        relevance,
        contextPrecision,
        groundedness,
    };
};
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
export const createJudgeHandler = (openai) => async (req, res) => {
    const { pipelineId, evaluations, model } = req.body;
    if (!pipelineId || !pipelineId.trim()) {
        return res.status(400).json({ error: 'pipelineId is required.' });
    }
    if (!Array.isArray(evaluations) || !evaluations.length) {
        return res
            .status(400)
            .json({ error: 'Provide at least one evaluation item.' });
    }
    try {
        const judgeDetails = [];
        for (const evaluation of evaluations) {
            const evalStarted = Date.now();
            try {
                const messages = buildJudgePrompt(evaluation);
                const completion = await openai.chatCompletion(messages, {
                    model: model?.trim() || undefined,
                    temperature: 0,
                    responseFormat: { type: 'json_object' },
                });
                const latencyMs = Date.now() - evalStarted;
                const parsed = parseJudgeResponse(JSON.parse(completion.content));
                judgeDetails.push({
                    taskId: evaluation.taskId,
                    verdict: parsed.verdict,
                    scores: {
                        relevance: parsed.relevance,
                        contextPrecision: parsed.contextPrecision,
                        groundedness: parsed.groundedness,
                    },
                    rationale: parsed.rationale,
                    missingCriteria: parsed.missingCriteria,
                    latencyMs,
                    usage: completion.usage,
                });
            }
            catch (innerError) {
                const latencyMs = Date.now() - evalStarted;
                const rationale = innerError instanceof Error ? innerError.message : 'Judge call failed.';
                judgeDetails.push({
                    taskId: evaluation.taskId,
                    verdict: 'review',
                    scores: {
                        relevance: 0,
                        contextPrecision: 0,
                        groundedness: 0,
                    },
                    rationale: `Unable to score answer automatically. ${rationale}`,
                    missingCriteria: ['Automatic evaluation failed'],
                    latencyMs,
                });
            }
        }
        const passCount = judgeDetails.filter((detail) => detail.verdict === 'pass').length;
        const passRate = judgeDetails.length ? passCount / judgeDetails.length : 0;
        const averageScores = {
            relevance: average(judgeDetails.map((detail) => detail.scores.relevance)),
            contextPrecision: average(judgeDetails.map((detail) => detail.scores.contextPrecision)),
            groundedness: average(judgeDetails.map((detail) => detail.scores.groundedness)),
        };
        const tokensUsed = judgeDetails.reduce((sum, detail) => sum + (detail.usage?.totalTokens ?? 0), 0);
        const latencyMsTotal = judgeDetails.reduce((sum, detail) => sum + detail.latencyMs, 0);
        const overallVerdict = passRate >= 0.8 && averageScores.groundedness >= 0.7 ? 'pass' : 'review';
        res.json({
            pipelineId,
            verdict: overallVerdict,
            passRate,
            averageScores,
            tokensUsed,
            latencyMs: latencyMsTotal,
            details: judgeDetails,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error';
        res.status(500).json({ error: message });
    }
};
