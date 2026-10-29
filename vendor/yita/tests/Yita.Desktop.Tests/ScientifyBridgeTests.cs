using System.Net;
using System.Text.Json;
using Yita.Desktop;

namespace Yita.Desktop.Tests;

public sealed class ScientifyBridgeTests
{
    [Fact]
    public async Task SharedConversationKeepsIdentityAndTransfersOnlyAnUnsentDraft()
    {
        using var wire = new StringWriter();
        using var bridge = new ScientifyBridge(wire);
        var conversationId = Guid.NewGuid();
        var read = bridge.ConversationAsync(conversationId, "read");
        var open = bridge.ConversationAsync(conversationId, "open", "unsent draft");
        var requests = wire.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonDocument.Parse(line).RootElement.Clone()).ToArray();
        Assert.All(requests, request => Assert.Equal(conversationId, request.GetProperty("request").GetProperty("conversationId").GetGuid()));
        Assert.Equal("unsent draft", requests[1].GetProperty("request").GetProperty("question").GetString());
        Assert.Equal("", requests[1].GetProperty("request").GetProperty("source").GetString());
        Deliver(bridge, new { id = requests[1].GetProperty("id").GetString(), result = new { conversationId, running = true } });
        Assert.True((await open).GetProperty("running").GetBoolean());
        Assert.False(read.IsCompleted);
        Deliver(bridge, new { id = requests[0].GetProperty("id").GetString(), result = new { conversationId, running = false } });
        Assert.False((await read).GetProperty("running").GetBoolean());
    }

    [Fact]
    public async Task DeletedConversationErrorIsVisibleInsteadOfRecreatingHistory()
    {
        using var wire = new StringWriter();
        using var bridge = new ScientifyBridge(wire);
        var request = bridge.ConversationAsync(Guid.NewGuid(), "send", "question");
        Deliver(bridge, new { id = Requests(wire)[0], result = new { error = "此会话已删除" } });
        var error = await Assert.ThrowsAsync<IOException>(() => request);
        Assert.Contains("已删除", error.Message);
        Assert.Single(Requests(wire));
    }

    [Fact]
    public async Task ParallelResponsesRemainIsolatedAndStreamBeforeCompletion()
    {
        using var wire = new StringWriter();
        using var bridge = new ScientifyBridge(wire);
        using var client = new HttpClient(bridge);
        var first = Request(client);
        var second = Request(client);
        var ids = Requests(wire);
        Assert.Equal(2, ids.Length);
        Deliver(bridge, new { type = "delta", id = ids[1], text = "第二段" });
        using var secondResponse = await second.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(first.IsCompleted);
        await using var stream = await secondResponse.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);
        Assert.Contains("第二段", JsonDocument.Parse((await reader.ReadLineAsync())![6..]).RootElement.GetProperty("choices")[0].GetProperty("delta").GetProperty("content").GetString());
        Deliver(bridge, new { type = "error", id = ids[0], error = "需要配置模型" });
        using var firstResponse = await first.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(HttpStatusCode.BadRequest, firstResponse.StatusCode);
        Assert.Contains("需要配置模型", JsonDocument.Parse(await firstResponse.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetProperty("message").GetString());
        Deliver(bridge, new { type = "complete", id = ids[1] });
        Assert.Contains("[DONE]", await reader.ReadToEndAsync());
    }

    [Fact]
    public async Task CancellingOneRequestAndParentDisconnectReleaseAllReaders()
    {
        using var wire = new StringWriter();
        using var bridge = new ScientifyBridge(wire);
        using var client = new HttpClient(bridge);
        using var cancelled = new CancellationTokenSource();
        var first = Request(client, cancelled.Token);
        var second = Request(client);
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<Exception>(() => first.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.False(second.IsCompleted);
        Assert.Contains("cancel", wire.ToString());
        bridge.Disconnect();
        await Assert.ThrowsAnyAsync<Exception>(() => second.WaitAsync(TimeSpan.FromSeconds(2)));
    }

    private static Task<HttpResponseMessage> Request(HttpClient client, CancellationToken token = default) =>
        client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "https://scientify.invalid/chat/completions")
        { Content = new StringContent("{\"messages\":[{\"role\":\"user\",\"content\":\"fixture\"}]}") }, HttpCompletionOption.ResponseHeadersRead, token);
    private static string[] Requests(StringWriter writer) => writer.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
        .Select(line => JsonDocument.Parse(line).RootElement.GetProperty("id").GetString()!).ToArray();
    private static void Deliver(ScientifyBridge bridge, object message) => bridge.Deliver(JsonSerializer.SerializeToElement(message));
}
