import anthropic

client = anthropic.Anthropic()  # reads API key from ANTHROPIC_API_KEY env var

response = client.messages.create(
    model="claude-opus-5",
    max_tokens=512,
    system="You are a concise, factual support-operations assistant.",
    messages=[{"role": "user", "content": "A customer cannot log in after a password reset. What do you need to help?"}],
)

for block in response.content:
    if block.type == "text":
        print(block.text)

print(f"Input tokens: {response.usage.input_tokens}, Output tokens: {response.usage.output_tokens}")
