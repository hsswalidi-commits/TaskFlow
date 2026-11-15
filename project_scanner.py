import os
import requests
from dotenv import load_dotenv

# تحميل متغيرات البيئة
load_dotenv()

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
KEY = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
MODEL = os.environ.get("OPENROUTER_MODEL") or os.environ.get("AI_MODEL", "google/gemini-2.0-flash-001")

def scan_and_review_project():
    if not KEY:
        print("❌ خطأ: مفتاح الـ API غير موجود في ملف .env")
        return

    project_files = []
    ignored_dirs = {'.git', '.venv', 'venv', '__pycache__', 'node_modules', '.idea', '.vscode'}
    
    print("📂 جاري فحص مجلد المشروع واكتشاف الملفات...")
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in ignored_dirs]
        for file in files:
            rel_path = os.path.relpath(os.path.join(root, file), ".")
            project_files.append(rel_path)

    print(f"\n📁 تم العثور على {len(project_files)} ملفاً في مشروعك:")
    for f in project_files:
        print(f"   - {f}")

    # قراءة محتوى الملفات البرمجية الأساسية (بايثون، جافاسكريبت، إتش تي إم إل، إلخ)
    code_contents = ""
    for f in project_files:
        if f.endswith(('.py', '.html', '.js', '.css', '.json')) and not f.startswith('.'):
            try:
                with open(f, "r", encoding="utf-8") as file_obj:
                    code_contents += f"\n\n==============================\nFILE: {f}\n==============================\n" + file_obj.read()
            except Exception as e:
                pass

    prompt = f"""
    You are an expert Senior Full-Stack and AI Engineer reviewing a trainee project called 'TaskFlow' (Task Manager with an Agentic AI Copilot).
    The user wants you to inspect the entire project structure and files to fix the issue where the AI Copilot is not fully functional for complex scheduling or goal breakdowns (like study plans, tool calling, etc.).

    Here is the list of all files in the project:
    {project_files}

    And here is the source code of the project files:
    {code_contents}

    Please analyze everything, identify why the AI agent isn't executing complex user goals properly, and provide:
    1. A summary of what files/components are currently present and how they interact.
    2. The exact root cause of why the AI behaves like a basic chatbot or fails to schedule.
    3. The exact, complete code modifications (Frontend JS & Backend Python) needed to make the AI Agent fully functional with proper Tool Calling and Task generation.
    """

    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2
    }

    headers = {
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "X-Title": "TaskFlow Deep Inspector"
    }

    print("\n🤖 جاري إرسال هيكل المشروع وكافة الملفات إلى الذكاء الاصطناعي للتحليل العميق...")
    try:
        response = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=90)
        if response.status_code == 200:
            result = response.json()
            content = result['choices'][0]['message']['content']
            print("\n" + "="*70)
            print("📋 تقرير الذكاء الاصطناعي الشامل وخطة التعديل:")
            print("="*70 + "\n")
            print(content)
        else:
            print(f"❌ خطأ من OpenRouter (كود {response.status_code}): {response.text}")
    except Exception as e:
        print(f"❌ حدث خطأ أثناء الاتصال: {e}")

if __name__ == "__main__":
    scan_and_review_project()