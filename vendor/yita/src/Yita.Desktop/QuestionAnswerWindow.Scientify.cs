using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Threading;
using Yita.Translation;

namespace Yita.Desktop;

internal sealed partial class QuestionAnswerWindow
{
    private Task? _hostInitialization;
    private readonly SemaphoreSlim _hostOperation = new(1, 1);
    private bool _hostSending;
    private string _hostSnapshot = "";
    private DispatcherTimer? _hostTimer;
    private string? _hostRecordQuestionId;

    private async Task EnsureHostConversationAsync()
    {
        var bridge = ScientifyBridge.Current ?? throw new IOException("Scientify 已断开。");
        try
        {
            await (_hostInitialization ??= bridge.ConversationAsync(_context.SessionId, "create",
                source: _kind == QuestionContextKind.GeneralChat ? "" : _source,
                translation: _kind == QuestionContextKind.GeneralChat ? "" : _translation,
                explanation: _kind == QuestionContextKind.Explanation ? _explanation : ""));
        }
        catch { _hostInitialization = null; throw; }
    }

    private void StartHostConversation()
    {
        _hostTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _hostTimer.Tick += async (_, _) => await RefreshHostConversationAsync();
        _hostTimer.Start();
        Closed += (_, _) => _hostTimer.Stop();
        _ = RefreshHostConversationAsync();
    }

    private async Task RefreshHostConversationAsync()
    {
        if (_closed || !IsVisible || !await _hostOperation.WaitAsync(0)) return;
        try
        {
            await EnsureHostConversationAsync();
            var snapshot = await ScientifyBridge.Current!.ConversationAsync(_context.SessionId, "read");
            ApplyHostSnapshot(snapshot);
            await RecordHostAnswerAsync(snapshot);
        }
        catch (Exception error) { ShowHostError(error.Message); }
        finally { _hostOperation.Release(); }
    }

    private void ApplyHostSnapshot(JsonElement snapshot)
    {
        if (_closed) return;
        var running = snapshot.GetProperty("running").GetBoolean();
        _streaming = running || _hostSending;
        _waitingForAnswer = false;
        StopButton.IsVisible = _streaming;
        SendButton.IsEnabled = !_streaming;
        if (_hostTimer is not null) _hostTimer.Interval = TimeSpan.FromMilliseconds(running ? 150 : 750);
        QuestionInputTextBox.IsEnabled = true;
        RetryButton.IsVisible = !_streaming && snapshot.TryGetProperty("canRetry", out var retry) && retry.GetBoolean();
        var messages = snapshot.GetProperty("messages");
        var serialized = messages.GetRawText();
        if (serialized != _hostSnapshot)
        {
            _hostSnapshot = serialized;
            _turns.Clear();
            foreach (var message in messages.EnumerateArray())
                _turns.Add(new ConversationTurn(message.GetProperty("role").GetString()!, message.GetProperty("text").GetString()!));
            _pendingAnswer = null;
            RenderTranscript();
            TranscriptScroll.ScrollToEnd();
        }
        var error = snapshot.TryGetProperty("error", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        EmptyStateText.IsVisible = _turns.Count == 0 || error is not null;
        EmptyStateText.Text = error ?? (_settings.UiLanguage == "zh-CN" ? "可以继续追问当前内容。" : "Ask a follow-up about this content.");
        UpdateRecordState();
        var truncated = snapshot.TryGetProperty("historyTruncated", out var limited) && limited.GetBoolean();
        ToolTip.SetTip(TranscriptText, truncated ? (_settings.UiLanguage == "zh-CN"
            ? "浮窗仅显示最近的内容，完整历史请点击箭头在 Scientify 中查看。"
            : "Recent content shown. Open Scientify for the full history.") : null);
    }

    private void ShowHostError(string message)
    {
        if (_closed) return;
        EmptyStateText.Text = message;
        EmptyStateText.IsVisible = true;
    }

    private async Task AskHostAsync(string question, bool retry = false)
    {
        if (_closed || _streaming || _hostSending || (!retry && string.IsNullOrWhiteSpace(question))) return;
        _hostSending = true;
        _streaming = true;
        SendButton.IsEnabled = false;
        // The first question can arrive from the translation popup rather than this textbox.
        if (!retry && string.IsNullOrWhiteSpace(QuestionInputTextBox.Text)) QuestionInputTextBox.Text = question;
        await _hostOperation.WaitAsync();
        try
        {
            await EnsureHostConversationAsync();
            var snapshot = await ScientifyBridge.Current!.ConversationAsync(_context.SessionId, retry ? "retry" : "send", question);
            var sentQuestion = snapshot.GetProperty("messages").EnumerateArray()
                .LastOrDefault(message => message.GetProperty("role").GetString() == "user");
            _hostRecordQuestionId = sentQuestion.ValueKind == JsonValueKind.Object ? sentQuestion.GetProperty("id").GetString() : null;
            if (!retry && QuestionInputTextBox.Text?.Trim() == question.Trim()) QuestionInputTextBox.Text = "";
            _hostSending = false;
            ApplyHostSnapshot(snapshot);
            await RecordHostAnswerAsync(snapshot);
        }
        catch (Exception error) { SetIdle(); ShowHostError(error.Message); }
        finally { _hostSending = false; _hostOperation.Release(); }
    }

    private async Task StopHostAsync()
    {
        await _hostOperation.WaitAsync();
        try { ApplyHostSnapshot(await ScientifyBridge.Current!.ConversationAsync(_context.SessionId, "cancel")); }
        catch (Exception error) { ShowHostError(error.Message); }
        finally { _hostOperation.Release(); }
    }

    // Retain Yita's optional Markdown record for turns sent here. Shared session persistence
    // is handled by Scientify even when this presentation window has been closed.
    private async Task RecordHostAnswerAsync(JsonElement snapshot)
    {
        if (_hostRecordQuestionId is null || snapshot.GetProperty("running").GetBoolean()
            || snapshot.GetProperty("canRetry").GetBoolean()) return;
        var messages = snapshot.GetProperty("messages").EnumerateArray().ToArray();
        var index = Array.FindIndex(messages, message => message.GetProperty("id").GetString() == _hostRecordQuestionId);
        if (index < 0) return;
        var answer = messages.Skip(index + 1).TakeWhile(message => message.GetProperty("role").GetString() == "assistant").LastOrDefault();
        if (answer.ValueKind != JsonValueKind.Object) return;
        _hostRecordQuestionId = null;
        var result = await _records.AppendQuestionAnswerAsync(_settings, _context with { TranslationText = _translation },
            messages[index].GetProperty("text").GetString()!, answer.GetProperty("text").GetString()!, _kind, DateTimeOffset.Now);
        if (result.ErrorCode is not null)
        {
            _recordError = result.ErrorCode;
            UpdateRecordState();
        }
    }
}
