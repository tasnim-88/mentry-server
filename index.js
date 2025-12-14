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

    // Lessons API
    app.get('/lessons', async (req, res) => {
      const cursor = lessonsCollection.find();
      const result = await cursor.toArray();
      res.send(result);
    })

    app.get('/lessondetails/:id', verifyFirebaseToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const lesson = await lessonsCollection.findOne(query);

      // Fetch the user to check premium
      const user = await usersCollection.findOne({ uid: req.user.uid });

      res.send({
        lesson,
        isPremiumUser: user?.isPremium || false,
      });
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
      });
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
