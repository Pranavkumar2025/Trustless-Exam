import express from 'express';
import { PrismaClient } from '@prisma/client';
import { decrypt, encrypt, key, iv } from './utils/crypto.js';
import Puzzle from 'crypto-puzzle';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
dotenv.config();


const { decodeUTF8, encodeBase64, decodeBase64 } = naclUtil;
const app = express();
const port = 3000;
const prisma = new PrismaClient();

// Middleware to parse JSON requests
app.use(express.json());

async function generateAndSolvePuzzle(targetDateTime) {
    try {
        // Get the current time and calculate the remaining time until the target date and time
        const currentTime = new Date();
        const targetTime = new Date(targetDateTime);

        console.log('Current time:', currentTime);
        console.log('Target time:', targetTime);

        const remainingTime = targetTime - currentTime;

        console.log('Remaining time (ms):', remainingTime);

        if (remainingTime <= 0) {
            throw new Error('The target date and time must be in the future');
        }

        const puzzle = await Puzzle.generate({
            opsPerSecond: 1_300_000,
            duration: remainingTime, // Set the duration to the remaining time in milliseconds
            message: 'What is 2 + 2' // Message for the puzzle
        });

        const solution = await Puzzle.solve(puzzle);
        console.log('Puzzle solved:', solution);
        return solution;
    } catch (error) {
        console.error('Failed to generate or solve puzzle:', error);
        throw error; // Propagate the error for handling in the caller
    }
}

// Endpoint to create an admin (plaintext password storage is not recommended in production)
app.post('/createadmin', async (req, res) => {
    const { username, password } = req.body;
    try {
        const admin = await prisma.admin.create({
            data: { username, password }, // Store plaintext password (not recommended in production)
        });
        res.json(admin);
    } catch (error) {
        console.error('Failed to create admin:', error);
        res.status(500).json({ error: 'Failed to create admin' });
    }
});

// Endpoint for admin login
app.post('/adminlogin', async (req, res) => {
    const { username, password } = req.body;
    try {
        const admin = await prisma.admin.findUnique({
            where: { username }
        });

        if (admin && admin.password === password) {
            res.json({ adminId: admin.id });
        } else {
            res.status(401).json({ error: 'Invalid username or password' });
        }
    } catch (error) {
        console.error('Failed to login:', error);
        res.status(500).json({ error: 'Failed to login' });
    }
});

// Endpoint to post a question
app.post('/question', async (req, res) => {
    const { adminId, question, option1, option2, option3, option4, correctOption } = req.body;

    try {
        if (!adminId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const questionsCount = await prisma.question.count({
            where: { adminId }
        });

        if (questionsCount >= 5) {
            return res.status(400).json({ error: 'An admin can only post up to 5 questions.' });
        }

        // Encrypt all options and correct option individually
        const encryptedQuestion = encrypt(question, key, iv);
        const encryptedOption1 = encrypt(option1, key, iv);
        const encryptedOption2 = encrypt(option2, key, iv);
        const encryptedOption3 = encrypt(option3, key, iv);
        const encryptedOption4 = encrypt(option4, key, iv);

        // Create a new question in the database
        const newQuestion = await prisma.question.create({
            data: {
                question: encryptedQuestion,
                option1: encryptedOption1,
                option2: encryptedOption2,
                option3: encryptedOption3,
                option4: encryptedOption4,
                admin: { connect: { id: adminId } }
            },
        });

        // Create a new answer in the database
        const newAnswer = await prisma.answer.create({
            data: {
                answer: encrypt(correctOption, key, iv),
                question: { connect: { id: newQuestion.id } }
            },
        });

        res.json({ newQuestion, newAnswer });
    } catch (error) {
        console.error('Failed to create question:', error);
        res.status(500).json({ error: 'Failed to create question' });
    }
});

app.post('/createstudent', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Hash the password before saving to the database
       

        const student = await prisma.student.create({
            data: {
                username,
                password
            }
        });

        res.status(201).json({ studentId: student.id });
    } catch (error) {
        console.error('Failed to create student:', error);
        res.status(500).json({ error: 'Failed to create student' });
    }
});


const SECRET_KEY = 'h2So4';

app.post('/studentlogin', async (req, res) => {
    const { username, password } = req.body;
    try {
        const std = await prisma.student.findUnique({
            where: { username }
        });

        if (std && std.password === password) {
            res.json({ studentid: std.id });
        } else {
            res.status(401).json({ error: 'Invalid username or password' });
        }
    } catch (error) {
        console.error('Failed to login:', error);
        res.status(500).json({ error: 'Failed to login' });
    }
});


app.get('/decryptedQuestions', async (req, res) => {
    try {
        const targetDateTime = '2024-07-16T17:18:00';
        await generateAndSolvePuzzle(targetDateTime);

        // Fetch all questions from the database
        const questions = await prisma.question.findMany({
            include: { answer: true }
        });

        if (questions.length === 0) {
            return res.status(404).json({ error: 'No questions found' });
        }

        // Decrypt all questions
        const decryptedQuestions = questions.map(question => ({
            questionId: question.id,
            question: decrypt(question.question, key, iv),
            option1: decrypt(question.option1, key, iv),
            option2: decrypt(question.option2, key, iv),
            option3: decrypt(question.option3, key, iv),
            option4: decrypt(question.option4, key, iv),
        }));

        res.json(decryptedQuestions);
    } catch (error) {
        console.error('Failed to fetch and decrypt questions:', error);
        res.status(500).json({ error: 'Failed to fetch and decrypt questions' });
    }
});


const keypair = nacl.sign.keyPair();
const queue = [];
let startTime = null;
let isFrozen = false;

// Middleware to check if the state machine is frozen
app.use((req, res, next) => {
  if (isFrozen && req.path !== '/verifyStateMachine' && req.method !== 'GET') {
    return res.status(403).json({ message: "State machine is frozen" });
  }
  next();
});

// Start the state machine
app.post('/start', (req, res) => {
  if (startTime) {
    return res.status(400).json({ message: "State machine already started" });
  }
  startTime = Date.now();
  queue.push({ state: 'started', timestamp: startTime });

  setTimeout(() => {
    isFrozen = true;
  }, 3 * 60 * 1000); // 1 minutes in milliseconds

  res.json({ message: "State machine started" });
});

// Transition to a new state
app.post('/transition', (req, res) => {
  if (isFrozen) {
    return res.status(403).json({ message: "State machine is frozen. Cannot transition." });
  }

  const { studentId, questionId, response } = req.body;
  if (!studentId || !questionId || !response) {
    return res.status(400).json({ message: "studentId, questionId, and response are required" });
  }

  const timestamp = Date.now();
  const message = JSON.stringify({ studentId, questionId, response, timestamp });
  const messageBytes = decodeUTF8(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

  queue.push({ studentId, questionId, response, timestamp, signature: encodeBase64(signature) });
  res.json({ message: "Response recorded", studentId, questionId, response, timestamp });
});

// Verify a state transition
app.post('/verifyStateMachine', (req, res) => {
  const { studentId, questionId, response, timestamp, signature } = req.body;
  if (!studentId || !questionId || !response || !timestamp || !signature) {
    return res.status(400).json({ message: "studentId, questionId, response, timestamp, and signature are required" });
  }

  const message = JSON.stringify({ studentId, questionId, response, timestamp });
  const messageBytes = decodeUTF8(message);
  const signatureBytes = decodeBase64(signature);

  const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, keypair.publicKey);

  res.json({ isValid, studentId, questionId, response });
});



// Get the state queue
app.get('/queue', (req, res) => {
  res.json(queue);
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
