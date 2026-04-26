let currentLayer = 1;
let seenQuestions = [];
const workerUrl = "https://dark-hall-6deb.dylangrow.workers.dev";

async function loadQuestion() {
    const optionsDiv = document.getElementById('options');
    const questionEl = document.getElementById('question');
    const feedback = document.getElementById('feedback');
    
    // UI Loading State
    questionEl.innerText = "Connecting to Layer " + currentLayer + "...";
    optionsDiv.innerHTML = "";
    feedback.innerText = "";
    document.getElementById('layer-display').innerText = `Layer: ${currentLayer}`;
    updateProgressBar();

    try {
        const response = await fetch(workerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ layer: currentLayer, history: seenQuestions })
        });

        const data = await response.json();
        
        // Safety check for malformed AI response
        if (!data.question || !data.options) throw new Error("Malformed data");

        seenQuestions.push(data.question.substring(0, 30)); // Save keyword for memory
        questionEl.innerText = data.question;

        Object.entries(data.options).forEach(([key, value]) => {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.innerText = `${key}: ${value}`;
            btn.onclick = () => checkAnswer(key, data);
            optionsDiv.appendChild(btn);
        });

    } catch (err) {
        questionEl.innerText = "Signal lost. Retrying...";
        setTimeout(loadQuestion, 2000);
    }
}

function checkAnswer(selected, data) {
    const feedback = document.getElementById('feedback');
    const buttons = document.querySelectorAll('.option-btn');

    // Disable all buttons to prevent double-clicks
    buttons.forEach(btn => btn.disabled = true);

    if (selected === data.answer) {
        feedback.style.color = "#00e5ff";
        feedback.innerText = "✓ CORRECT: " + data.explanation;
        
        setTimeout(() => {
            currentLayer++;
            if (currentLayer > 7) {
                showWinState();
            } else {
                loadQuestion();
            }
        }, 3000);
    } else {
        feedback.style.color = "#ff1744";
        feedback.innerText = `✗ INCORRECT. Answer was ${data.answer}. ${data.explanation}`;
        
        // Let them try a new question at same layer after a delay
        setTimeout(() => {
            buttons.forEach(btn => btn.disabled = false);
            loadQuestion();
        }, 4000);
    }
}

function updateProgressBar() {
    const fill = document.getElementById('progress-bar');
    fill.style.width = (currentLayer / 7) * 100 + "%";
}

function showWinState() {
    document.getElementById('game-container').innerHTML = `
        <h1 style="color: #00e5ff">OSI MASTERED</h1>
        <p>System fully optimized. All 7 layers verified.</p>
        <button class="option-btn" onclick="location.reload()">REBOOT SYSTEM</button>
    `;
}

// Initial Boot
loadQuestion();
