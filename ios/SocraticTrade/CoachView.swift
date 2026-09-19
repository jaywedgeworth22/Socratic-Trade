import SwiftUI

/// Live Coach chat — same `/api/chat` + `/api/chat-history` path as the web console assistant.
/// The phone never runs inference; the backend remains authoritative.
struct CoachView: View {
    @EnvironmentObject private var store: MobileStore

    @State private var turns: [ChatTurn] = []
    @State private var draft: String = ""
    @State private var selectedModel: String = UserDefaults.standard.string(forKey: CoachModelCatalog.storageKey) ?? ""
    @State private var providers: [String: Bool] = [:]
    @State private var isLoading = true
    @State private var isSending = false
    @State private var loadError: String?
    @State private var lastDraft: ChatDraft?
    @State private var lastLearning: String?

    var body: some View {
        VStack(spacing: 0) {
            if isLoading && turns.isEmpty {
                ProgressView("Loading Coach")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                transcript
                if let lastDraft {
                    CoachDraftCard(draft: lastDraft)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .frame(maxWidth: ContentColumns.readableWidth)
                        .frame(maxWidth: .infinity)
                }
                composer
            }
        }
        .background(AppPalette.background.ignoresSafeArea())
        .navigationTitle("Coach")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    ForEach(CoachModelCatalog.options) { option in
                        Button {
                            select(option)
                        } label: {
                            Label(
                                option.label,
                                systemImage: selectedModel == option.id ? "checkmark" : "circle"
                            )
                        }
                        .disabled(!CoachModelCatalog.isAvailable(option, providers: providers) && !providers.isEmpty)
                    }
                    Divider()
                    Button("Clear Conversation", role: .destructive) {
                        Task { await clearHistory() }
                    }
                    .disabled(isSending || turns.isEmpty)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Coach Options")
            }
        }
        .task { await bootstrap() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    CoachIntroCard(modelLabel: currentModelLabel)
                    if let error = loadError {
                        InlineErrorBanner(
                            message: error,
                            retry: { Task { await bootstrap() } },
                            dismiss: { loadError = nil }
                        )
                    }
                    if turns.isEmpty && !isLoading {
                        EmptyStateCard(
                            title: "No Conversation Yet",
                            message: "Ask about positions, the latest scan, or why a proposal is waiting.",
                            systemImage: "bubble.left.and.bubble.right"
                        )
                    }
                    ForEach(turns) { turn in
                        CoachBubble(turn: turn)
                            .id(turn.id)
                    }
                    if isSending {
                        HStack {
                            ProgressView()
                            Text("Coach is thinking…")
                                .font(.appCaption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 4)
                        .id("sending")
                    }
                    if let lastLearning, !lastLearning.isEmpty {
                        Text(lastLearning)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(maxWidth: ContentColumns.readableWidth)
                // Second frame centres the clamped column on an iPad or a Mac window.
                .frame(maxWidth: .infinity)
            }
            .onChange(of: turns.count) { _, _ in
                scrollToEnd(proxy)
            }
            .onChange(of: isSending) { _, sending in
                if sending { scrollToEnd(proxy) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let option = selectedOption {
                Text(option.detail)
                    .font(.appCaption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask Coach", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .padding(12)
                    .background(AppPalette.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .disabled(isSending)
                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(canSend ? AppPalette.accent : Color.secondary.opacity(0.35))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: ContentColumns.readableWidth)
        // Composer stays under the transcript it belongs to, not stretched across the window.
        .frame(maxWidth: .infinity)
        .background(AppPalette.background)
    }

    private var canSend: Bool {
        !isSending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var selectedOption: CoachModelCatalog.Option? {
        CoachModelCatalog.options.first(where: { $0.id == selectedModel })
    }

    private var currentModelLabel: String {
        selectedOption?.label ?? "choose a model"
    }

    private func select(_ option: CoachModelCatalog.Option) {
        selectedModel = option.id
        UserDefaults.standard.set(option.id, forKey: CoachModelCatalog.storageKey)
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        let target = isSending ? "sending" : turns.last?.id
        guard let target else { return }
        withAnimation {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    private func bootstrap() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let history = store.fetchChatHistory()
            async let available = store.fetchChatProviders()
            turns = try await history
            providers = try await available
            if selectedModel.isEmpty,
               let first = CoachModelCatalog.firstAvailable(providers: providers) {
                select(first)
            }
            loadError = nil
        } catch let error as MobileAPIError {
            if case .unauthorized = error {
                store.error = error.localizedDescription
            }
            loadError = error.localizedDescription
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        draft = ""
        isSending = true
        defer { isSending = false }
        let clientTurnId = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(32)
        let optimistic = ChatTurn(
            id: "local-\(clientTurnId)",
            role: "user",
            text: text,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
        turns.append(optimistic)
        do {
            let reply = try await store.sendChat(
                message: text,
                model: selectedModel.isEmpty ? nil : selectedModel,
                clientTurnId: String(clientTurnId)
            )
            turns.append(
                ChatTurn(
                    id: "reply-\(clientTurnId)",
                    role: "assistant",
                    text: reply.text,
                    citations: reply.citations.map(\.source),
                    intent: reply.intent,
                    model: reply.model,
                    createdAt: ISO8601DateFormatter().string(from: Date())
                )
            )
            lastDraft = reply.draft
            lastLearning = reply.learningCapture?.receipt
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func clearHistory() async {
        do {
            try await store.clearChatHistory()
            turns = []
            lastDraft = nil
            lastLearning = nil
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct CoachIntroCard: View {
    let modelLabel: String

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Coach", systemImage: "bubble.left.and.text.bubble.right.fill")
                    .font(.appHeadline)
                    .foregroundStyle(AppPalette.accent)
                Text("Ask about a name, a pending proposal, or the last scan.  Model: \(modelLabel).")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct CoachBubble: View {
    let turn: ChatTurn

    var body: some View {
        HStack {
            if turn.isUser { Spacer(minLength: 36) }
            VStack(alignment: turn.isUser ? .trailing : .leading, spacing: 6) {
                // Assistant replies are markdown (headings, bullets, tables, bold).
                // What the owner typed is not — render it exactly as typed, same split
                // the console makes between AssistantMarkdown and a plain paragraph.
                if turn.isUser {
                    Text(turn.text)
                        .font(.appBody)
                        .foregroundStyle(Color.white)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    CoachMarkdownText(turn.text)
                        .font(.appBody)
                        .foregroundStyle(Color.primary)
                }
                if !turn.citations.isEmpty {
                    Text(turn.citations.joined(separator: " · "))
                        .font(.appCaption2)
                        .foregroundStyle(turn.isUser ? Color.white.opacity(0.8) : Color.secondary)
                }
                if let model = turn.model, !model.isEmpty, !turn.isUser {
                    Text(model)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .background(
                turn.isUser ? AppPalette.accent : AppPalette.card,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            if !turn.isUser { Spacer(minLength: 36) }
        }
    }
}

private struct CoachDraftCard: View {
    let draft: ChatDraft

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Suggested Draft", systemImage: "doc.text")
                    .font(.appHeadline)
                Text("\(draft.side.uppercased()) \(draft.symbol)")
                    .font(.appTitle3.weight(.semibold))
                if let qty = draft.quantity {
                    Text("\(AppFormat.number(qty)) shares")
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                }
                if let rationale = draft.rationale, !rationale.isEmpty {
                    Text(rationale)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if draft.blocked == true {
                    Text("This draft will not place an order.")
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                } else {
                    // Do not promise "approve it in Proposals": /api/proposals/from-draft is
                    // wired only from the web draft card, so there is no path from an iOS
                    // Coach draft into the approval queue.
                    Text("This is a draft only.  Nothing is sent until it is staged for approval.")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
