using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;

namespace Yita.Desktop;

/// <summary>Private inherited pipes, not a listening HTTP server. No model keys leave Scientify.</summary>
internal sealed class ScientifyBridge : HttpMessageHandler
{
    internal static ScientifyBridge? Current { get; private set; }
    internal static bool IsEmbedded => Environment.GetEnvironmentVariable("SCIENTIFY_TRANSLATION_DATA") is not null;
    private readonly TextWriter _output;
    private readonly ConcurrentDictionary<string, Channel<JsonElement>> _pending = new();
    internal ScientifyBridge(TextWriter output) => _output = output;

    internal static void Start(MainWindow window, IClassicDesktopStyleApplicationLifetime desktop)
    {
        var bridge = Current!;
        _ = Task.Run(async () =>
        {
            try
            {
                using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
                while (await reader.ReadLineAsync() is { } line)
                {
                    if (line.Length > 2 * 1024 * 1024) throw new IOException("Scientify message too large.");
                    using var document = JsonDocument.Parse(line);
                    var message = document.RootElement.Clone();
                    if (message.GetProperty("type").GetString() == "command")
                        Dispatcher.UIThread.Post(async () =>
                        {
                            var id = message.GetProperty("id").GetString();
                            try
                            {
                                var result = await window.HandleScientifyCommandAsync(message.GetProperty("action"));
                                bridge.Send(new { type = "reply", id, result });
                            }
                            catch (Exception error) { bridge.Send(new { type = "reply", id, error = error.Message }); }
                        });
                    else bridge.Deliver(message);
                }
            }
            catch (Exception error) { Console.Error.WriteLine($"Scientify translation bridge: {error.GetType().Name}"); }
            finally
            {
                bridge.Disconnect();
                Dispatcher.UIThread.Post(() => desktop.Shutdown());
            }
        });
    }

    internal static HttpClient CreateClient()
    {
        Current = new ScientifyBridge(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        return new HttpClient(Current) { Timeout = Timeout.InfiniteTimeSpan };
    }

    internal void Send(object value)
    {
        lock (_output) _output.WriteLine(JsonSerializer.Serialize(value));
    }

    internal void Deliver(JsonElement message)
    {
        if (_pending.TryGetValue(message.GetProperty("id").GetString()!, out var channel))
            channel.Writer.TryWrite(message);
    }

    internal void Disconnect()
    {
        foreach (var channel in _pending.Values) channel.Writer.TryComplete(new IOException("Scientify 已断开。"));
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid().ToString();
        var channel = Channel.CreateUnbounded<JsonElement>(new() { SingleReader = true, SingleWriter = true });
        _pending[id] = channel;
        var registration = cancellationToken.Register(() =>
        {
            Send(new { type = "cancel", id });
            channel.Writer.TryComplete(new OperationCanceledException(cancellationToken));
        });
        try
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            Send(new { type = "completion", id, body = body.RootElement });
            var first = await channel.Reader.ReadAsync(cancellationToken);
            if (first.GetProperty("type").GetString() == "error")
            {
                Release();
                return new HttpResponseMessage(first.TryGetProperty("status", out var status) ? (HttpStatusCode)status.GetInt32() : HttpStatusCode.BadRequest)
                {
                    Content = new StringContent(JsonSerializer.Serialize(new { error = new { message = first.GetProperty("error").GetString() } }))
                };
            }
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new EventStream(first, channel.Reader, Release))
            };
            response.Content.Headers.ContentType = new("text/event-stream");
            return response;
        }
        catch { Release(); throw; }

        void Release()
        {
            registration.Dispose();
            if (_pending.TryRemove(id, out _)) Send(new { type = "cancel", id });
        }
    }

    internal async Task HandoffAsync(string source, string translation, string? question)
    {
        var id = Guid.NewGuid().ToString();
        var channel = Channel.CreateUnbounded<JsonElement>();
        _pending[id] = channel;
        try
        {
            Send(new { type = "handoff", id, source, translation, question });
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var reply = await channel.Reader.ReadAsync(timeout.Token);
            if (reply.TryGetProperty("error", out var error)) throw new IOException(error.GetString());
        }
        finally { _pending.TryRemove(id, out _); }
    }

    private sealed class EventStream(JsonElement first, ChannelReader<JsonElement> reader, Action release) : Stream
    {
        private JsonElement? _first = first;
        private byte[] _bytes = [];
        private int _offset;
        private bool _done;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (buffer.Length == 0) return 0;
            if (_offset == _bytes.Length)
            {
                if (_done) return 0;
                var item = _first ?? await reader.ReadAsync(cancellationToken);
                _first = null;
                var type = item.GetProperty("type").GetString();
                if (type == "error") throw new IOException(item.GetProperty("error").GetString());
                _done = type == "complete";
                _bytes = Encoding.UTF8.GetBytes(_done ? "data: [DONE]\n\n" : "data: " + JsonSerializer.Serialize(new
                { choices = new[] { new { delta = new { content = item.GetProperty("text").GetString() } } } }) + "\n\n");
                _offset = 0;
            }
            var count = Math.Min(buffer.Length, _bytes.Length - _offset);
            _bytes.AsMemory(_offset, count).CopyTo(buffer);
            _offset += count;
            return count;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        protected override void Dispose(bool disposing) { if (disposing) release(); base.Dispose(disposing); }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
