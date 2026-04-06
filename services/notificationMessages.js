/**
 * ChatFace Notification Messages
 *
 * Kurallar:
 * - 6 saatte bir gönderim
 * - Aynı mesaj art arda kullanılmaz (servis katmanında kontrol edilir)
 * - Baskısız, sohbet odaklı ton
 */

const notificationMessages = {

  chatface_conversation_reminder: {
    tr: [
      { title: "ChatFace", message: "Görüşme hazır. Sohbete başlayabilirsin." },
      { title: "ChatFace", message: "AI seni bekliyor. Görüşmeyi başlat." },
      { title: "ChatFace", message: "Kısa bir görüntülü sohbet ister misin." },
      { title: "ChatFace", message: "Etkileşim için buradayız." },
      { title: "ChatFace", message: "Bir konuşma aç, devam et." },
      { title: "ChatFace", message: "Yeni bir AI görüşmesi başlatılabilir." }
    ],
    en: [
      { title: "ChatFace", message: "Your session is ready. You can start chatting." },
      { title: "ChatFace", message: "AI is waiting for you. Start the conversation." },
      { title: "ChatFace", message: "Would you like a short video chat." },
      { title: "ChatFace", message: "We are here for interaction." },
      { title: "ChatFace", message: "Open a conversation and keep it going." },
      { title: "ChatFace", message: "A new AI session can be started." }
    ],
    de: [
      { title: "ChatFace", message: "Das Gesprach ist bereit. Du kannst den Chat starten." },
      { title: "ChatFace", message: "Die KI wartet auf dich. Starte das Gesprach." },
      { title: "ChatFace", message: "Lust auf einen kurzen Videochat." },
      { title: "ChatFace", message: "Wir sind fur Interaktion da." },
      { title: "ChatFace", message: "Offne ein Gesprach und mach weiter." },
      { title: "ChatFace", message: "Eine neue KI Sitzung kann gestartet werden." }
    ],
    es: [
      { title: "ChatFace", message: "La conversacion esta lista. Puedes empezar a chatear." },
      { title: "ChatFace", message: "La IA te esta esperando. Inicia la conversacion." },
      { title: "ChatFace", message: "Quieres una videollamada corta." },
      { title: "ChatFace", message: "Estamos aqui para interactuar." },
      { title: "ChatFace", message: "Abre una conversacion y continua." },
      { title: "ChatFace", message: "Se puede iniciar una nueva sesion con IA." }
    ],
    fr: [
      { title: "ChatFace", message: "La conversation est prete. Tu peux commencer a discuter." },
      { title: "ChatFace", message: "L IA t attend. Lance la conversation." },
      { title: "ChatFace", message: "Envie d un court appel video." },
      { title: "ChatFace", message: "Nous sommes la pour l interaction." },
      { title: "ChatFace", message: "Ouvre une conversation et continue." },
      { title: "ChatFace", message: "Une nouvelle session IA peut etre lancee." }
    ],
    ja: [
      { title: "ChatFace", message: "会話の準備ができました。チャットを始められます。" },
      { title: "ChatFace", message: "AIがあなたを待っています。会話を始めましょう。" },
      { title: "ChatFace", message: "短いビデオチャットはいかがですか。" },
      { title: "ChatFace", message: "交流のためにここにいます。" },
      { title: "ChatFace", message: "会話を開いて続けてみましょう。" },
      { title: "ChatFace", message: "新しいAIセッションを開始できます。" }
    ],
    ko: [
      { title: "ChatFace", message: "대화가 준비됐어요. 채팅을 시작할 수 있어요." },
      { title: "ChatFace", message: "AI가 기다리고 있어요. 대화를 시작해요." },
      { title: "ChatFace", message: "짧은 영상 통화는 어떠세요." },
      { title: "ChatFace", message: "우리는 상호작용을 위해 여기 있어요." },
      { title: "ChatFace", message: "대화를 열고 이어가 보세요." },
      { title: "ChatFace", message: "새로운 AI 세션을 시작할 수 있어요." }
    ],
    pt: [
      { title: "ChatFace", message: "A conversa esta pronta. Voce pode comecar a conversar." },
      { title: "ChatFace", message: "A IA esta esperando por voce. Inicie a conversa." },
      { title: "ChatFace", message: "Quer um video chat rapido." },
      { title: "ChatFace", message: "Estamos aqui para interacao." },
      { title: "ChatFace", message: "Abra uma conversa e continue." },
      { title: "ChatFace", message: "Uma nova sessao de IA pode ser iniciada." }
    ],
    ru: [
      { title: "ChatFace", message: "Разговор готов. Можно начать общение." },
      { title: "ChatFace", message: "AI ждет тебя. Начни разговор." },
      { title: "ChatFace", message: "Хочешь короткий видеочат." },
      { title: "ChatFace", message: "Мы здесь для взаимодействия." },
      { title: "ChatFace", message: "Открой разговор и продолжай." },
      { title: "ChatFace", message: "Можно начать новый AI сеанс." }
    ],
    hi: [
      { title: "ChatFace", message: "बातचीत तैयार है। आप चैट शुरू कर सकते हैं।" },
      { title: "ChatFace", message: "AI आपका इंतजार कर रहा है। बातचीत शुरू करें।" },
      { title: "ChatFace", message: "क्या आप छोटी वीडियो चैट चाहेंगे।" },
      { title: "ChatFace", message: "हम इंटरैक्शन के लिए यहां हैं।" },
      { title: "ChatFace", message: "एक बातचीत खोलें और जारी रखें।" },
      { title: "ChatFace", message: "नई AI बातचीत शुरू की जा सकती है।" }
    ],
    it: [
      { title: "ChatFace", message: "La conversazione e pronta. Puoi iniziare a chattare." },
      { title: "ChatFace", message: "L AI ti aspetta. Avvia la conversazione." },
      { title: "ChatFace", message: "Ti va una breve videochiamata." },
      { title: "ChatFace", message: "Siamo qui per interagire." },
      { title: "ChatFace", message: "Apri una conversazione e continua." },
      { title: "ChatFace", message: "Si puo avviare una nuova sessione AI." }
    ],
    zh: [
      { title: "ChatFace", message: "会话已准备好，你可以开始聊天。" },
      { title: "ChatFace", message: "AI正在等你，开始这次对话吧。" },
      { title: "ChatFace", message: "想来一段简短的视频聊天吗。" },
      { title: "ChatFace", message: "我们在这里，随时陪你互动。" },
      { title: "ChatFace", message: "打开一段对话，继续聊下去。" },
      { title: "ChatFace", message: "可以开始一场新的AI会话。" }
    ]
  }
};

notificationMessages.custom = notificationMessages.chatface_conversation_reminder;

module.exports = notificationMessages;
