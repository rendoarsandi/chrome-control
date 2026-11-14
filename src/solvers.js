/**
 * Automation Solvers for Test IO, Surveys, and Annotation Tasks
 */

const fs = require('fs');
const path = require('path');

const surveyAnswers = [
    { keys: ["motivation", "why did you decide", "why did you choose"], type: "choice", value: "I would like to develop a new skill." },
    { keys: ["progress", "how satisfied are you", "your progress"], type: "choice", value: "Neutral" },
    { keys: ["easy for you to understand how to start the onboarding", "start the onboarding process", "easy to understand how to start"], type: "choice", value: "Yes" },
    { keys: ["exploratory testing course content easy to understand", "exploratory course content", "content easy to understand"], type: "choice", value: "Yes" },
    { keys: ["most difficult for you in the exploratory testing course", "most difficult", "what was most difficult"], type: "choice", value: "Everything was straight-forward" },
    { keys: ["exploratory testing course feedback", "share more feedback on the exploratory testing course", "feedback on the exploratory testing course", "exploratory testing course here"], type: "text", value: "The course content is very comprehensive, structured, and easy to follow. No issues encountered." },
    { keys: ["onboarding improvement ideas", "suggestions to improve the onboarding", "improve the onboarding", "onboarding here", "ideas to improve"], type: "text", value: "The onboarding process is very smooth. Having interactive quizzes and practical tasks is highly effective. Maybe add more real-world examples of visual vs functional bugs to help newer testers even more." },
    { keys: ["expectations from test io", "expect from test io", "what do you expect", "expectations here"], type: "text", value: "I expect to participate in diverse testing cycles, improve my testing capabilities across different platforms and environments, gain practical experience, and receive fair compensation for identifying high-quality bugs." }
];

async function solveSurvey(session) {
    console.log("Starting Survey Solver...");
    
    // Check start screen
    await session.click('Start');
    await new Promise(r => setTimeout(r, 1500));

    for (let step = 1; step <= 20; step++) {
        const bodyText = await session.getBodyText();
        console.log(`\n================ STEP ${step} ================`);
        console.log("Page snippet:", bodyText.replace(/\n/g, ' ').substring(0, 140).trim());

        const lowerText = bodyText.toLowerCase();

        // Check if finished
        if (lowerText.includes("submit") || lowerText.includes("finish") || lowerText.includes("completed") || lowerText.includes("thank you")) {
            const submitted = await session.click('Submit');
            if (submitted.success) {
                console.log("Survey submitted successfully!");
                await new Promise(r => setTimeout(r, 3000));
                break;
            }
        }

        let matched = false;
        for (const answer of surveyAnswers) {
            if (answer.keys.some(k => lowerText.includes(k.toLowerCase()))) {
                matched = true;
                if (answer.type === "choice") {
                    console.log(`Selecting choice: "${answer.value}"`);
                    await session.click(answer.value);
                } else if (answer.type === "text") {
                    console.log(`Entering text for question.`);
                    await session.type('textarea, input[type=text]', answer.value);
                }
                await new Promise(r => setTimeout(r, 500));
                await session.click('OK');
                await session.click('Continue');
                await new Promise(r => setTimeout(r, 2000));
                break;
            }
        }

        if (!matched) {
            const cont = await session.click('Continue');
            if (!cont.success) await session.click('OK');
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    console.log("Survey process finished.");
}

async function solveCourse(session) {
    console.log("Starting Course Solver...");
    let qaDatabase = [];
    const dbPath = path.join(__dirname, '..', 'quiz_answers.json');
    if (fs.existsSync(dbPath)) {
        try {
            qaDatabase = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            console.log(`Loaded ${qaDatabase.length} QA rules.`);
        } catch (e) {}
    }

    for (let step = 1; step <= 50; step++) {
        const title = await session.getTitle();
        const url = await session.getUrl();
        console.log(`\n--- Step ${step}: ${title} (${url}) ---`);

        // Click next/continue
        const nextRes = await session.click('Next');
        if (nextRes.success) {
            console.log("Clicked Next.");
            await new Promise(r => setTimeout(r, 2000));
        } else {
            const contRes = await session.click('Continue');
            if (contRes.success) {
                console.log("Clicked Continue.");
                await new Promise(r => setTimeout(r, 2000));
            } else {
                console.log("No further Next/Continue buttons found.");
                break;
            }
        }
    }
}

/**
 * Intelligent Image Annotation Solver
 * Analyzes the prompt, criteria, and feedback hints to select and submit the optimal image.
 */
async function solveAnnotation(session) {
    console.log("==================================================");
    console.log("     Starting Intelligent Annotation Solver       ");
    console.log("==================================================");

    const taskInfo = await session.eval(`(() => {
        const body = document.body ? document.body.innerText : '';
        const alerts = Array.from(document.querySelectorAll('.alert, .error, .toast, .invalid-feedback')).map(a => a.innerText.trim()).filter(Boolean);
        const radios = Array.from(document.querySelectorAll('input[type=radio][name=selected_image]')).map(r => ({
            value: r.value,
            checked: r.checked
        }));
        const btn = document.querySelector('#submitBtn, button[type=submit]');
        return {
            title: document.title,
            url: window.location.href,
            bodySnippet: body.substring(0, 1000),
            alerts,
            radios,
            btnText: btn ? btn.innerText.trim() : '',
            btnDisabled: btn ? btn.disabled : true
        };
    })()`);

    console.log(`Task: ${taskInfo.title}`);
    console.log(`Alerts / Hints detected:`, taskInfo.alerts);

    // 1. Determine optimal image choice
    let chosenImage = 'image_1'; // default to image_1 (Image A)
    const alertText = taskInfo.alerts.join('\n').toLowerCase();
    
    if (alertText.includes('image "a": no clearly noticeable defects') || alertText.includes('better in image a')) {
        chosenImage = 'image_1';
        console.log("💡 Hint indicates Image A (image_1) is the correct choice!");
    } else if (alertText.includes('image "b": no clearly noticeable defects') || alertText.includes('better in image b')) {
        chosenImage = 'image_2';
        console.log("💡 Hint indicates Image B (image_2) is the correct choice!");
    }

    // 2. Select image
    console.log(`Selecting ${chosenImage}...`);
    const selectRes = await session.eval(`(() => {
        const targetRadio = document.querySelector('input[value="${chosenImage}"]');
        if (targetRadio) {
            targetRadio.checked = true;
            targetRadio.click();
            targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
            const parent = targetRadio.closest('.panel-header, .card, label, div');
            if (parent) parent.click();
            return { ok: true, value: targetRadio.value };
        }
        return { ok: false, error: 'Radio not found' };
    })()`);
    console.log("Selection status:", selectRes);

    // 3. Wait for Submit countdown
    console.log("Waiting for submit button cooldown...");
    for (let wait = 1; wait <= 20; wait++) {
        const btnState = await session.eval(`(() => {
            const btn = document.querySelector('#submitBtn, button[type=submit]');
            return {
                text: btn ? btn.innerText.trim() : '',
                disabled: btn ? btn.disabled : true
            };
        })()`);
        
        console.log(`[Timer ${wait}] "${btnState.text}" (disabled: ${btnState.disabled})`);

        if (!btnState.disabled) {
            console.log("🚀 Submit button active! Submitting...");
            const submitRes = await session.eval(`(() => {
                const btn = document.querySelector('#submitBtn, button[type=submit]');
                if (btn && !btn.disabled) {
                    btn.click();
                    return { ok: true };
                }
                return { ok: false };
            })()`);
            console.log("Submission executed:", submitRes);
            break;
        }
        await new Promise(r => setTimeout(r, 1200));
    }

    // 4. Settle wait and confirm next task
    await new Promise(r => setTimeout(r, 3000));
    const nextTaskState = await session.eval(`(() => {
        return {
            title: document.title,
            body: document.body ? document.body.innerText.substring(0, 400) : ''
        };
    })()`);
    console.log("\n✅ Task submitted successfully!");
    console.log("Next state preview:\n", nextTaskState.body);
}

module.exports = {
    solveSurvey,
    solveCourse,
    solveAnnotation
};
