// Test file for chrome-control-cli fuzzy solver logic
const assert = require('assert');

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

function matchQuestion(blockText) {
    const lowerText = blockText.toLowerCase();
    for (const answer of surveyAnswers) {
        const isMatch = answer.keys.some(key => lowerText.includes(key.toLowerCase()));
        if (isMatch) {
            return answer;
        }
    }
    return null;
}

// Test cases
try {
    // Test Case 1: Match Question d
    const qD = "d. If necessary, you can share more feedback on the Exploratory Testing Course here.";
    const matchD = matchQuestion(qD);
    assert.ok(matchD, "Should match Question d");
    assert.strictEqual(matchD.type, "text");
    assert.strictEqual(matchD.value, "The course content is very comprehensive, structured, and easy to follow. No issues encountered.");
    
    // Test Case 2: Match Question c
    const qC = "c. What was the most difficult for you in the Exploratory Testing Course?";
    const matchC = matchQuestion(qC);
    assert.ok(matchC, "Should match Question c");
    assert.strictEqual(matchC.type, "choice");
    assert.strictEqual(matchC.value, "Everything was straight-forward");

    // Test Case 3: Match Onboarding suggestions
    const qE = "e. Do you have any suggestions to improve the onboarding process?";
    const matchE = matchQuestion(qE);
    assert.ok(matchE, "Should match Question e");
    assert.strictEqual(matchE.type, "text");

    console.log("All solver logic unit tests passed successfully!");
} catch (e) {
    console.error("Test failed:", e);
    process.exit(1);
}
