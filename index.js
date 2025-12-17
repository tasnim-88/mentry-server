const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 3000

const stripe = require('stripe')(process.env.STRIPE_SECRET);

var admin = require("firebase-admin");

var serviceAccount = require("./digital-lesson-authenti-5320e-firebase-adminsdk-fbsvc-fbcd6128cd.json");

let usersCollection;
let lessonsCollection;


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      await usersCollection.updateOne(
        { uid: session.metadata.uid },
        {
          $set: {
            isPremium: true,
            upgradedAt: new Date(),
          },
        }
      );
    }

    res.json({ received: true });
  }
);

// Middleware
app.use(express.json())
app.use(cors())

const verifyFirebaseToken = async (req, res, next) => {
  const token = req.headers.authorization

  if (!token) {
    return res.status(401).send({ message: 'Unauthorized access!' })
  }

  try {
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    req.user = decoded;
    next()
  }
  catch (err) {
    return res.status(401).send({ message: 'Unauthorized access!' })
  }

}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xksrcg5.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});



async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("mentry");
    usersCollection = db.collection("users");
    lessonsCollection = db.collection("lessons");
    const lessonsReportsCollection = db.collection('lessonsReports');
    const commentsCollection = db.collection('comments');

    // Lessons API
    // app.get('/lessons', async (req, res) => {
    //   const cursor = lessonsCollection.find();
    //   const result = await cursor.toArray();
    //   res.send(result);
    // })

    // app.get('/lessons', async (req, res) => {
    //   const { uid } = req.query;
    //   const query = uid ? { uid } : {};
    //   const lessons = await lessonsCollection.find(query).toArray();
    //   res.send(lessons);
    // });

    app.get('/lessons', async (req, res) => {
      try {
        const { uid } = req.query;

        const query = {
          'metadata.privacy': { $ne: 'Private' },
          'metadata.visibility': { $ne: 'Hidden' },
        };

        // If profile page → only that user's lessons
        if (uid) {
          query['author.uid'] = uid;
        }

        const lessons = await lessonsCollection
          .find(query)
          .sort({ 'metadata.createdDate': -1 })
          .toArray();

        res.send(lessons);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to fetch lessons' });
      }
    });

    // 4. LESSON DETAILS Endpoint Refinement
    app.get('/lessondetails/:id', verifyFirebaseToken, async (req, res) => {
      const lessonId = req.params.id;
      const userId = req.user.uid; // Get the ID of the currently logged-in user

      // Fetch Lesson
      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });

      if (!lesson) {
        return res.status(404).send({ message: 'Lesson not found' });
      }

      // Fetch User
      const user = await usersCollection.findOne({ uid: userId });

      const isAuthor = lesson.author?.uid === userId;
      const isPremiumUser = user?.isPremium === true;

      // Check Engagement Status
      const userHasLiked = lesson.stats?.likesArray?.includes(userId) || false;
      const userHasFavorited = user?.favoritesArray?.includes(lessonId) || false; // Check user's saved array

      const { privacy, accessLevel } = lesson.metadata;

      // 🔒 Private lesson → author only
      if (privacy === 'Private' && !isAuthor) {
        return res.status(403).send({ message: 'This lesson is private' });
      }

      // 💎 Premium lesson → premium users only
      if (accessLevel === 'Premium' && !isPremiumUser && !isAuthor) {
        return res.status(403).send({ message: 'Premium access required' });
      }

      // ✅ Access granted
      res.send({
        lesson,
        isPremiumUser,
        isAuthor,
        // RETURN THESE FLAGS TO THE CLIENT
        userHasLiked,
        userHasFavorited
      });
    });



    app.post('/lessons', verifyFirebaseToken, async (req, res) => {
      try {
        const lesson = req.body;

        // 🔒 Enforce author from Firebase token
        lesson.author.uid = req.user.uid;
        lesson.author.email = req.user.email;

        // 1️⃣ Insert lesson
        const result = await lessonsCollection.insertOne(lesson);

        // 2️⃣ Increment user's total lessons
        await usersCollection.updateOne(
          { uid: req.user.uid },
          { $inc: { totalLessons: 1 } },
          { upsert: true }
        );

        res.send({
          success: true,
          lessonId: result.insertedId,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Failed to create lesson' });
      }
    });

    // My lessons
    app.get('/my-lessons', verifyFirebaseToken, async (req, res) => {
      const lessons = await lessonsCollection
        .find({ "author.uid": req.user.uid })
        .sort({ "metadata.createdDate": -1 })
        .toArray();

      res.send(lessons);
    });

    // NEW PAGINATED ROUTE: Fixes the 404 error from the client dashboard.
    // URL: /mylessons?page=1&limit=3
    app.get('/mylessons', verifyFirebaseToken, async (req, res) => {
      const userUid = req.user.uid;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      try {
        const query = { 'author.uid': userUid };

        const lessons = await lessonsCollection
          .find(query)
          .sort({ 'metadata.createdDate': -1 }) // Sort by newest first
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalLessons = await lessonsCollection.countDocuments(query);

        res.send({
          lessons: lessons,
          totalLessons: totalLessons,
          currentPage: page,
          totalPages: Math.ceil(totalLessons / limit)
        });

      } catch (error) {
        console.error("Error fetching user's lessons:", error);
        res.status(500).send({ message: 'Failed to fetch user lessons' });
      }
    });

    // Endpoint 1: Get Total Lessons Created by User
    app.get('/mylessons/count', verifyFirebaseToken, async (req, res) => {
      const userUid = req.user.uid;

      try {
        const count = await lessonsCollection.countDocuments({ 'author.uid': userUid });
        res.send({ count });
      } catch (error) {
        console.error("Error fetching lesson count:", error);
        res.status(500).send({ message: 'Failed to fetch lesson count' });
      }
    });

    // Endpoint 2: Get Total Saved (Favorite) Lessons Count
    app.get('/myfavorites/count', verifyFirebaseToken, async (req, res) => {
      const userUid = req.user.uid;

      try {
        const user = await usersCollection.findOne(
          { uid: userUid },
          // Update the projection to match your actual database fields
          { projection: { savedLessons: 1, favoritesArray: 1 } }
        );

        // Option A: Use the dedicated counter (fastest)
        // Option B: Fallback to the array length if the counter isn't synced
        const count = user?.savedLessons ?? user?.favoritesArray?.length ?? 0;

        res.send({ count });

      } catch (error) {
        console.error("Error fetching favorite count:", error);
        res.status(500).send({ message: 'Failed to fetch favorite count' });
      }
    });

    // GET /user-activity: Contributions per day for the last 7 days
    app.get('/user-activity', verifyFirebaseToken, async (req, res) => {
      try {
        const userId = req.user.uid;
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const activity = await lessonsCollection.aggregate([
          {
            $match: {
              "author.uid": userId,
              "metadata.createdDate": { $gte: sevenDaysAgo.toISOString() }
            }
          },
          {
            $group: {
              _id: { $substr: ["$metadata.createdDate", 0, 10] }, // Group by YYYY-MM-DD
              count: { $sum: 1 }
            }
          },
          { $sort: { "_id": 1 } }
        ]).toArray();

        // Format for Recharts
        const chartData = activity.map(item => ({
          day: item._id,
          lessons: item.count
        }));

        res.send(chartData);
      } catch (error) {
        res.status(500).send({ message: 'Failed to fetch activity' });
      }
    });

    app.patch('/lessons/:id', verifyFirebaseToken, async (req, res) => {
      const { id } = req.params;
      const updates = req.body;

      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!lesson) {
        return res.status(404).send({ message: 'Lesson not found' });
      }

      // 🔒 Ownership check
      if (lesson.author.uid !== req.user.uid) {
        return res.status(403).send({ message: 'Forbidden' });
      }

      // 🔒 Premium enforcement
      const user = await usersCollection.findOne({ uid: req.user.uid });
      if (updates?.metadata?.accessLevel === 'Premium' && !user?.isPremium) {
        return res.status(403).send({ message: 'Premium required' });
      }

      updates.metadata.lastUpdated = new Date().toISOString();

      await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updates }
      );

      res.send({ success: true });
    });

    app.delete('/lessons/:id', verifyFirebaseToken, async (req, res) => {
      const { id } = req.params;

      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!lesson) {
        return res.status(404).send({ message: 'Lesson not found' });
      }

      if (lesson.author.uid !== req.user.uid) {
        return res.status(403).send({ message: 'Forbidden' });
      }

      await lessonsCollection.deleteOne({ _id: new ObjectId(id) });

      // 🔻 Decrement total lessons
      await usersCollection.updateOne(
        { uid: req.user.uid },
        { $inc: { totalLessons: -1 } }
      );

      res.send({ success: true });
    });


    // GET similar lessons
    // app.get('/similar-lessons/:id', async (req, res) => {
    //   const currentLessonId = req.params.id;
    //   const { category, tone } = req.query; // Expect category and tone as query params

    //   if (!category && !tone) {
    //     return res.send([]); // Return empty if no criteria provided
    //   }

    //   const query = {
    //     _id: { $ne: new ObjectId(currentLessonId) }, // Exclude the current lesson
    //     'metadata.privacy': { $ne: 'Private' },
    //     'metadata.visibility': { $ne: 'Hidden' },
    //     $or: [
    //       { 'lessonInfo.category': category },
    //       { 'lessonInfo.tone': tone },
    //     ],
    //   };

    //   try {
    //     const similarLessons = await lessonsCollection
    //       .find(query)
    //       .limit(6) // Display at most 6 cards
    //       .toArray();

    //     res.send(similarLessons);
    //   } catch (error) {
    //     console.error("Error fetching similar lessons:", error);
    //     res.status(500).send({ message: 'Failed to fetch similar lessons' });
    //   }
    // });

    app.get('/similar-lessons/:id', async (req, res) => {
      const currentLessonId = req.params.id;
      const { category, tone } = req.query; // Expect category and tone as query params

      if (!category && !tone) {
        return res.send([]); // Return empty if no criteria provided
      }

      // Define the list of access states that should NOT be visible publicly
      const EXCLUDED_VISIBILITY_STATES = ['Private', 'Hidden']; // Assuming 'Private' means Premium

      const query = {
        // 1. Exclusion: Exclude the current lesson
        _id: { $ne: new ObjectId(currentLessonId) },

        // 2. Access Control: Ensure the lesson is PUBLIC (i.e., not private, not hidden)
        'metadata.visibility': {
          $nin: EXCLUDED_VISIBILITY_STATES // Filters out both Premium ('Private') and Hidden lessons
        },

        // 3. Privacy Control (Optional but good for security):
        'metadata.visibility': { $ne: 'Private' }, // Assuming this targets a different kind of 'Private' setting

        // 4. Similarity Logic: Match by Category OR Tone
        $or: [
          { 'lessonInfo.category': category },
          { 'lessonInfo.tone': tone },
        ],
      };

      try {
        const similarLessons = await lessonsCollection
          .find(query)
          .limit(6) // Display at most 6 cards
          .toArray();

        res.send(similarLessons);
      } catch (error) {
        console.error("Error fetching similar lessons:", error);
        res.status(500).send({ message: 'Failed to fetch similar lessons' });
      }
    });

    app.get('/public-lessons', async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      try {
        // Define the visibility states that should NOT be visible publicly.
        const EXCLUDED_VISIBILITY_STATES = ['Private', 'Hidden']; // Correct variable definition

        const query = {
          // Filter 1: Exclude lessons that are premium or hidden
          'metadata.visibility': {
            // ⭐️ FIX: Corrected the typo from EXCLUDED_VISCLUDED_VISIBILITY_STATES
            $nin: EXCLUDED_VISIBILITY_STATES
          },

          // Filter 2 (Optional but recommended): Ensures lessons specifically marked as private are excluded.
          'metadata.privacy': { $ne: 'Private' },
        };

        const publicLessons = await lessonsCollection
          .find(query)
          .sort({ 'metadata.createdDate': -1 }) // Sort by newest first
          .skip(skip)
          .limit(limit)
          .toArray();

        // Get total count for pagination metadata
        const totalLessons = await lessonsCollection.countDocuments(query);

        res.send({
          lessons: publicLessons,
          totalLessons: totalLessons,
          currentPage: page,
          totalPages: Math.ceil(totalLessons / limit)
        });

      } catch (error) {
        console.error("Error fetching public lessons:", error);
        res.status(500).send({ message: 'Failed to fetch public lessons' });
      }
    });

    // 2. CONFIRMED ENDPOINT: Like / Unlike Toggle
    app.post('/lesson/:id/like', verifyFirebaseToken, async (req, res) => {
      try {
        const lessonId = req.params.id;
        const userId = req.user.uid;
        const { action } = req.body; // 'like' or 'unlike'

        if (action === 'like') {
          // Use $addToSet to ensure userId is only added once
          const result = await lessonsCollection.updateOne(
            { _id: new ObjectId(lessonId), 'stats.likesArray': { $ne: userId } },
            {
              $addToSet: { 'stats.likesArray': userId },
              $inc: { 'stats.likes': 1 }
            }
          );
          // Only report success if a modification happened (i.e., it wasn't already liked)
          return res.send({ success: result.modifiedCount > 0, message: 'Lesson liked' });
        }

        if (action === 'unlike') {
          // Use $pull to remove userId if it exists
          const result = await lessonsCollection.updateOne(
            { _id: new ObjectId(lessonId), 'stats.likesArray': userId },
            {
              $pull: { 'stats.likesArray': userId },
              $inc: { 'stats.likes': -1 }
            }
          );
          // Only report success if a modification happened (i.e., it was previously liked)
          return res.send({ success: result.modifiedCount > 0, message: 'Lesson unliked' });
        }

        res.status(400).send({ message: 'Invalid action specified' });
      } catch (error) {
        console.error("Error toggling like:", error);
        res.status(500).send({ message: 'Failed to process like action' });
      }
    });


    // 3. CONFIRMED ENDPOINT: Favorite / Unfavorite Toggle
    app.post('/lesson/:id/favorite', verifyFirebaseToken, async (req, res) => {
      try {
        const lessonId = req.params.id;
        const userId = req.user.uid;
        const { action } = req.body; // 'favorite' or 'unfavorite'

        const isFavoriting = action === 'favorite';
        const operator = isFavoriting ? '$addToSet' : '$pull';
        const increment = isFavoriting ? 1 : -1;

        // 1. Update User document (for saved lessons list and count)
        const userUpdateResult = await usersCollection.updateOne(
          { uid: userId },
          {
            [operator]: { favoritesArray: lessonId },
            $inc: { savedLessons: increment }
          },
          { upsert: true }
        );

        // If the user's document was modified (i.e., the state changed), update the lesson count
        if (userUpdateResult.modifiedCount > 0 || userUpdateResult.upsertedCount > 0) {
          // 2. Update Lesson document (for favorite count)
          await lessonsCollection.updateOne(
            { _id: new ObjectId(lessonId) },
            { $inc: { 'stats.favorites': increment } }
          );
        }

        res.send({ success: true, message: `Lesson ${action}d` });

      } catch (error) {
        console.error("Error toggling favorite:", error);
        res.status(500).send({ message: 'Failed to process favorite action' });
      }
    });

    // GET Favorite Lessons for the current user
    app.get('/my-favorites', verifyFirebaseToken, async (req, res) => {
      try {
        const userId = req.user.uid;
        // ⭐️ NEW: Read optional filter parameters from query
        const { category, tone } = req.query;

        // 1. Fetch the logged-in user's document to get the favoritesArray
        const user = await usersCollection.findOne(
          { uid: userId },
          { projection: { favoritesArray: 1 } }
        );

        const favoriteLessonIds = user?.favoritesArray || [];

        if (favoriteLessonIds.length === 0) {
          return res.send([]);
        }

        // Convert the string IDs in the array to MongoDB's ObjectId type
        const objectIds = favoriteLessonIds
          .map(id => {
            try {
              return new ObjectId(id);
            } catch (e) {
              return null;
            }
          })
          .filter(id => id !== null);

        // 2. ⭐️ NEW: Build the query object for lessons
        const lessonQuery = {
          _id: { $in: objectIds },
        };

        if (category && category !== 'Filter by Category') {
          lessonQuery['lessonInfo.category'] = category;
        }

        if (tone && tone !== 'Filter by Tone') {
          lessonQuery['lessonInfo.tone'] = tone;
        }

        // 3. Fetch the full lesson documents using the constructed query
        const favoriteLessons = await lessonsCollection.find(lessonQuery)
          .sort({ "metadata.createdDate": -1 })
          .toArray();

        res.send(favoriteLessons);
      } catch (error) {
        console.error("Error fetching favorite lessons:", error);
        res.status(500).send({ message: 'Failed to fetch favorite lessons' });
      }
    });


    // POST /lesson/:id/report
    app.post('/lesson/:id/report', verifyFirebaseToken, async (req, res) => {
      try {
        const { id: lessonId } = req.params;
        const { reason } = req.body; // Reason from the client modal

        // Data from the verifyFirebaseToken middleware
        const reporterUserId = req.user.uid;
        const reportedUserEmail = req.user.email;

        if (!reason || typeof reason !== 'string' || reason.length < 5) {
          return res.status(400).send({ message: 'Invalid or missing reason for report.' });
        }

        // Optional: Check if the lesson ID is valid before proceeding
        let objectIdLessonId;
        try {
          objectIdLessonId = new ObjectId(lessonId);
        } catch (e) {
          return res.status(400).send({ message: 'Invalid Lesson ID format.' });
        }

        // ⭐️ Create the report document
        const reportDoc = {
          lessonId: objectIdLessonId,
          reporterUserId: reporterUserId,
          reportedUserEmail: reportedUserEmail,
          reason: reason,
          timestamp: new Date(),
          status: 'Pending Review' // Default status
        };

        const result = await lessonsReportsCollection.insertOne(reportDoc);

        if (result.acknowledged) {
          res.status(201).send({ message: 'Lesson reported successfully.', reportId: result.insertedId });
        } else {
          res.status(500).send({ message: 'Failed to save report.' });
        }

      } catch (error) {
        console.error("Error submitting lesson report:", error);
        res.status(500).send({ message: 'Internal server error while reporting lesson.' });
      }
    });

    // ⭐️ 2. GET Comments for a Lesson
    app.get('/lesson/:id/comments', async (req, res) => {
      try {
        const lessonId = req.params.id;
        let objectIdLessonId;
        try {
          objectIdLessonId = new ObjectId(lessonId);
        } catch (e) {
          return res.status(400).send({ message: 'Invalid Lesson ID format.' });
        }

        // Find all comments for this lesson, sorted by creation date (newest first)
        const lessonComments = await commentsCollection
          .find({ lessonId: objectIdLessonId })
          .sort({ createdAt: -1 })
          .toArray();

        res.send({ comments: lessonComments });
      } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).send({ message: 'Failed to fetch comments' });
      }
    });

    // ⭐️ 3. POST New Comment to a Lesson
    app.post('/lesson/:id/comments', verifyFirebaseToken, async (req, res) => {
      try {
        const lessonId = req.params.id;
        const userId = req.user.uid;
        const { content } = req.body; // The comment text from the client

        if (!content || typeof content !== 'string' || content.trim().length < 1) {
          return res.status(400).send({ message: 'Comment content cannot be empty.' });
        }

        let objectIdLessonId;
        try {
          objectIdLessonId = new ObjectId(lessonId);
        } catch (e) {
          return res.status(400).send({ message: 'Invalid Lesson ID format.' });
        }

        // Fetch the user's profile to get their name and photo for the comment
        const userProfile = await usersCollection.findOne(
          { uid: userId },
          { projection: { displayName: 1, photoURL: 1 } }
        );

        // Construct the comment document
        const newComment = {
          lessonId: objectIdLessonId, // Link to the lesson
          content: content.trim(),
          author: {
            uid: userId,
            name: userProfile?.displayName || req.user.email,
            profileImage: userProfile?.photoURL || '',
          },
          createdAt: new Date(),
        };

        const result = await commentsCollection.insertOne(newComment);

        if (result.acknowledged) {
          res.status(201).send({
            message: 'Comment posted successfully',
            commentId: result.insertedId,
            // Optionally send back the full document (including timestamp)
            newComment: newComment
          });
        } else {
          res.status(500).send({ message: 'Failed to save comment.' });
        }

      } catch (error) {
        console.error("Error posting comment:", error);
        res.status(500).send({ message: 'Internal server error while posting comment.' });
      }
    });

    // Users API
    app.get('/users', async (req, res) => {
      const cursor = usersCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    })

    app.get('/users/me', verifyFirebaseToken, async (req, res) => {
      const user = await usersCollection.findOne({ uid: req.user.uid });

      res.send({
        isPremium: user?.isPremium || false,
        totalLessons: user?.totalLessons || 0,
        savedLessons: user?.savedLessons || 0,
      });
    });

    // UPDATE USER PROFILE (name / photo)
    app.patch('/users/me', verifyFirebaseToken, async (req, res) => {
      const { displayName, photoURL } = req.body;

      const update = {};
      if (displayName) update.displayName = displayName;
      if (photoURL) update.photoURL = photoURL;

      // Update users collection
      await usersCollection.updateOne(
        { uid: req.user.uid },
        { $set: update },
        { upsert: true }
      );


      // OPTIONAL: sync all lessons authored by user
      await lessonsCollection.updateMany(
        { 'author.uid': req.user.uid },
        {
          $set: {
            'author.name': displayName,
            'author.profileImage': photoURL,
          },
        }
      );

      res.send({ success: true });
    });

    // GET user profile by UID (e.g., for a public profile page)
    app.get('/users/:authorUid', async (req, res) => {
      try {
        const authorUid = req.params.authorUid;

        // 1. Fetch the user's document using the UID from the URL
        const user = await usersCollection.findOne(
          { uid: authorUid },
          {
            // Projection: Only return necessary public data
            projection: {
              _id: 0, // Exclude Mongo ID
              uid: 1,
              displayName: 1,
              email: 1, // You might choose to hide the email
              photoURL: 1,
              totalLessons: 1,
              savedLessons: 1,
              isPremium: 1, // Useful for displaying a badge
            },
          }
        );

        if (!user) {
          return res.status(404).send({ message: 'User not found' });
        }

        // You might want to filter out sensitive fields before sending
        const publicProfile = {
          uid: user.uid,
          displayName: user.displayName || 'Anonymous User',
          photoURL: user.photoURL || '',
          totalLessons: user.totalLessons || 0,
          savedLessons: user.savedLessons || 0,
          isPremium: user.isPremium || false, // Display a "Premium" badge if they have it
          // Intentionally omitting email for public view
        };

        res.send(publicProfile);

      } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).send({ message: 'Failed to fetch user profile' });
      }
    });


    // GET user by email
    app.get('/users/:email', async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });

    app.post('/users', async (req, res) => {
      const user = req.body;
      console.log(user);
      const result = await usersCollection.insertOne(user);
      res.send(result);
    })

    // Payment Intent API
    app.post('/create-checkout-session', verifyFirebaseToken, async (req, res) => {

      const user = await usersCollection.findOne({ uid: req.user.uid });

      if (user?.isPremium) {
        return res.status(400).send({
          message: 'User already has Premium access',
        });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        customer_email: req.user.email,
        line_items: [
          {
            price_data: {
              currency: 'bdt',
              product_data: { name: 'Premium Lifetime Access' },
              unit_amount: 1500 * 100,
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.SITE_DOMAIN}/payment/success`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment/cancel`,
        metadata: {
          uid: req.user.uid,
        },
      });

      res.send({ url: session.url });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Mentry is mentoring!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
