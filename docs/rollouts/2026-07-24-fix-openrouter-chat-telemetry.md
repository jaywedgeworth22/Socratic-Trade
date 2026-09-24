1. **Context & Objective**: OpenRouter telemetry events were reporting 0 usage in the usage monitor for `Socratic-Trade` console sessions because `getLLM()` silently fell back to a `MockLLM` for OpenRouter, causing no chat events to be logged or executed.
2. **Changes Made**:
   - Updated `getLLM` in `src/lib/chat/llm.ts` to properly route `CHAT_LLM="openrouter"` to `OpenAILLM` using `resolveLlmCredential("openrouter")`.
   - Fixed a mapping issue in `classifierTelemetryMetadata` (`src/lib/usage-monitor-push.ts`) where `userId` was passed to the `telemetryEventClassifier` instead of the expected `user` property for the `UsageTelemetryV2EventSchema`.
3. **Decisions & Trade-offs**: 
   - Utilized `makeOpenAITransport(openAiCompatChatUrl("openrouter"), "openrouter")` for the OpenRouter compatibility endpoint.
4. **Verification State**: 
   - Ran `npx tsc --noEmit && npm test`.
   - Build passes. Tests pass.
5. **Next Steps & Blockers**: 
   - None. The fix restores standard chat usage telemetry ingestion for OpenRouter.
