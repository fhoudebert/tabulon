exports.model = Model = {
    Game: {},
    Board: {},
    Move: {}
};


(function() {

	var cbVar, gameState;

	var MASK = 0xffff;   // unreachable position
	var FLAG_MOVE = 0x10000; // move to if target pos empty
	var FLAG_CAPTURE = 0x20000; // capture if occupied by enemy
	var FLAG_STOP = 0x40000; // stop if occupied
	var FLAG_SCREEN_CAPTURE = 0x80000; // capture if occupied by and a piece has been jumped in the path (like cannon in xiangqi) 
	var FLAG_CAPTURE_KING = 0x100000; // capture if occupied by enemy king
	var FLAG_CAPTURE_NO_KING = 0x200000; // capture if not occupied by enemy king
	var FLAG_SPECIAL = 0x400000; // non-captures to go on special move stack
	var FLAG_CAPTURE_SELF = 0x800000; // special move to square occupied by friend
	var FLAG_SPECIAL_CAPTURE = 0x2000000; // special move to square occupied by foe
	var FLAG_THREAT = 0x1000000; // forces inclusion in threat graph
	Model.Game.cbConstants = {
		MASK: MASK,
		FLAG_MOVE: FLAG_MOVE,
		FLAG_CAPTURE: FLAG_CAPTURE,
		FLAG_STOP: FLAG_STOP,
		FLAG_SCREEN_CAPTURE: FLAG_SCREEN_CAPTURE,
		FLAG_CAPTURE_KING: FLAG_CAPTURE_KING,
		FLAG_CAPTURE_NO_KING: FLAG_CAPTURE_NO_KING,
		FLAG_SPECIAL: FLAG_SPECIAL,
		FLAG_CAPTURE_SELF: FLAG_CAPTURE_SELF,
		FLAG_SPECIAL_CAPTURE: FLAG_SPECIAL_CAPTURE,
		FLAG_THREAT: FLAG_THREAT,
	}
	var USE_TYPED_ARRAYS = typeof Int32Array != "undefined";
	
	Model.Game.cbUseTypedArrays = USE_TYPED_ARRAYS; 

	Model.Game.cbTypedArray = function(array) {
		if(USE_TYPED_ARRAYS) {
			var tArray=new Int32Array(array.length);
			tArray.set(array);
			return tArray;
		} else {
			var arr=[];
			var arrLength=array.length;
			for(var i=0;i<arrLength;i++)
				arr.push(array[i]);
			return arr;
		}
	}

	Model.Game.cbShortRangeGraph = function(geometry,deltas,confine,flags) {
		var $this=this;
		if(flags===undefined)
			flags = FLAG_MOVE | FLAG_CAPTURE;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos]=[];
			if(confine && !(pos in confine))
				continue;
			deltas.forEach(function(delta) {
				var pos1=geometry.Graph(pos,delta);
				if(pos1!=null) {
					var f=flags;
					if(confine) {
						if(!(pos1 in confine)) return;
						if(confine[pos1] == 'b') f &= ~(FLAG_MOVE|FLAG_SPECIAL);
					}
					if(!flags || f) graph[pos].push($this.cbTypedArray([pos1 | f]));
				}
			});
		}
		return graph;
	}
	
	Model.Game.cbLongRangeGraph = function(geometry,deltas,confine,flags,maxDist) {
		var $this=this;
		if(flags===undefined || flags==null)
			flags=FLAG_MOVE | FLAG_CAPTURE;
		if(!maxDist)
			maxDist=Infinity;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos]=[];
			if(confine && !(pos in confine))
				continue;
			deltas.forEach(function(delta) {
				var direction=[];
				var pos1=geometry.Graph(pos,delta);
				var dist=0;
				while(pos1!=null) {
					var brouhaha=0;
					if(confine) {
						if(!(pos1 in confine)) break;
						if(confine[pos1]=='b') brouhaha=FLAG_MOVE|FLAG_SPECIAL;
					}
					if(!flags || flags & ~brouhaha) direction.push(pos1 | flags & ~brouhaha);
					if(brouhaha || ++dist==maxDist)
						break;
					pos1=geometry.Graph(pos1,delta);
				}
				if(direction.length>0)
					graph[pos].push($this.cbTypedArray(direction));
			});
		}
		return graph;
	}
	
	Model.Game.cbNullGraph = function(geometry) {
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++)
			graph[pos]=[];
		return graph;
	}
	
	Model.Game.cbAuthorGraph = function(geometry) {
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos]=[];
			for(var pos1=0;pos1<geometry.boardSize;pos1++)
				graph[pos].push([pos1|FLAG_MOVE|FLAG_CAPTURE|FLAG_CAPTURE_NO_KING])
		}
		return graph;
	}
	
	Model.Game.cbMergeGraphs = function(geometry) {
		var graph = [];
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos] = [];
			for(var i=1;i<arguments.length;i++)
				graph[pos] = graph[pos].concat(arguments[i][pos]);
		}
		return graph;
	}

	Model.Game.cbGetThreatGraph = function() {
		var $this=this;
		
		this.cbUseScreenCapture=false;
		this.cbUseCaptureKing=false;
		this.cbUseCaptureNoKing=false;
		var threatGraph={
			'1': [],
			'-1': [],
		};

		var lines=[];
		for(var pos=0;pos<this.g.boardSize;pos++) {
			this.g.pTypes.forEach(function(pType,typeName) {
				pType.graph[pos].forEach(function(line1) {
					var line=[];
					for(var i=0;i<line1.length;i++) {
						var tg1=line1[i];
						if(tg1 & FLAG_CAPTURE_KING) {
							$this.cbUseCaptureKing=true;
							line.unshift({d:tg1 & MASK,a:pos,tk:typeName});
						} else if(tg1 & FLAG_CAPTURE_NO_KING) {
							$this.cbUseCaptureNoKing=true;
							line.unshift({d:tg1 & MASK,a:pos,tnk:typeName});
						} else if(tg1 & (FLAG_CAPTURE | FLAG_THREAT))
							line.unshift({d:tg1 & MASK,a:pos,t:typeName});
						else if(tg1 & FLAG_STOP)
							line.unshift({d:tg1 & MASK,a:pos});
						if(tg1 & FLAG_SCREEN_CAPTURE) {
							$this.cbUseScreenCapture=true;
							line.unshift({d:tg1 & MASK,a:pos,ts:typeName});
						}
					}
					if(line.length>0)
						lines.push(line);
				});
			});
		}

		var allAttackers={};

		lines.forEach(function(line) {
			line.forEach(function(lineItem,lineIndex) {
				var attackers=allAttackers[lineItem.d];
				if(attackers===undefined) {
					attackers={};
					allAttackers[lineItem.d]=attackers;
				}
				var poss=[];
				for(var i=lineIndex+1;i<line.length;i++)
					poss.push(line[i].d);
				poss.push(lineItem.a);
				var key=poss.join(",");
				var att0=attackers[key];
				if(att0===undefined) {
					att0={
						p: poss,
						t: {},
						ts: {},
						tk: {},
					}
					attackers[key]=att0;
				}
				if(lineItem.t!==undefined)
					att0.t[lineItem.t]=true;
				else if(lineItem.tk!==undefined)
					att0.tk[lineItem.tk]=true;
				else if(lineItem.ts!==undefined)
					att0.ts[lineItem.ts]=true;
			});
		});
		
		for(var pos=0;pos<$this.g.boardSize;pos++) {
			var attackers=allAttackers[pos];
			
			function Compact(tree,base) {
				for(var i in attackers) {
					var attacker=attackers[i];
					if(attacker.p.length<base.length+1)
						continue;
					var candidate=true;
					for(var j=0;j<base.length;j++)
						if(base[j]!=attacker.p[j]) {
							candidate=false;
							break;
						}
					if(!candidate)
						continue;
					var nextPos=attacker.p[base.length];
					var nextBranch=tree[nextPos];
					if(nextBranch===undefined) {
						nextBranch={e:{}};
						tree[nextPos]=nextBranch;
					}
					if(attacker.p.length==base.length+1) {
						nextBranch.t=attacker.t;
						nextBranch.ts=attacker.ts;
						nextBranch.tk=attacker.tk;
						delete attackers[i];
					}
					//Compact(nextBranch.e,base.concat([nextPos]));
					base.push(nextPos);
					Compact(nextBranch.e,base);
					base.pop();
				}
			}
			var tree={};
			Compact(tree,[]);
			
			threatGraph[1][pos]=tree;
			threatGraph[-1][pos]=tree;
		}

		return threatGraph;
	}

	var boardKeys=[], typeKeys=[];

	function ZobristInit(t, pTypes, size) { // home-brewn hash scheme
		var mt = JocGame.LetsTwist(12345);
		for(var i=0; i<size; i++)
			boardKeys[i]=mt.genrand_int32()|1<<16;
		for(var i=0; i<pTypes.length; i++) {
			var k = pTypes[i];
			typeKeys[3*k-1]=mt.genrand_int32()|1;
			typeKeys[3*k+1]=mt.genrand_int32()|1;
		}
	}

	Model.Game.InitGame = function() {
		var $this=this;
		this.cbVar = cbVar = this.cbDefine();
		
		this.g.boardSize = this.cbVar.geometry.boardSize;

		this.g.pTypes = this.cbGetPieceTypes();
		this.g.threatGraph = this.cbGetThreatGraph();
		this.g.distGraph = this.cbVar.geometry.GetDistances();
		
		this.cbPiecesCount = 0;
		if(this.cbMaxRepeats === undefined) this.cbMaxRepeats = 3;
		if(this.cbPawnTypes === undefined) {
			var k, first; // assume Pawns are defined first
			for(k in this.g.pTypes) {
				var a = this.g.pTypes[k].abbrev;
				if(first === undefined) first = a;
				if(a != first) break;
			}
			this.cbPawnTypes=k;
		}
		this.g.castleablePiecesCount = { '1': 0, '-1': 0 };
		for(var i in cbVar.pieceTypes) {
			var pType=cbVar.pieceTypes[i];
			if(pType.castle) {
				var initial=pType.initial || [];
				initial.forEach(function(iniPiece) {
					$this.g.castleablePiecesCount[iniPiece.s]++;
				});
			}
			if(pType.initial)
				this.cbPiecesCount += pType.initial.length; 
		}

		if(typeof(this.extraInit) == 'function') this.extraInit(this.cbVar.geometry);

		var typeValues = Object.keys(cbVar.pieceTypes);

	    if(cbVar.zobrist == "old") {
		// Deprecated Zobrist initialization, kept for book probing
		var boardValues=[];
		for(var i=0;i<this.cbPiecesCount;i++) 
			boardValues.push(i);
		this.zobrist=new JocGame.Zobrist({
			board: {
				type: "array",
				size: this.cbVar.geometry.boardSize,
				values: boardValues,
			},
			who: {
				values: ["1","-1"],			
			},
			type: {
				type: "array",
				size: this.cbPiecesCount,
				values: typeValues
			}
		});

		// the following three can replace the active functions for backward compatibility
		this.bKey = function(piece) {
			return $this.zobrist.update(0,"board",piece.i,piece.p);
		}

		this.tKey = function(piece) {
			return $this.zobrist.update(0,"type",piece.t,piece.i);
		}

		this.wKey = function(h) {
			var w = $this.zobrist.update(0,"who",-1)
			if(h) w ^= $this.zobrist.update(0,"who",1);
			return w;
		}
	    } else {
		// three active update functions called by ApplyMove()
		this.bKey = function(piece) { // takes care of type and location dependence
			return typeKeys[3*piece.t+piece.s]*boardKeys[piece.p];
		}

		this.tKey= function(piece) { // dummy in new scheme
			return 0;
		}

		this.wKey= function() { // side-to-move key
			return 2;
		}

		ZobristInit(this, typeValues, this.cbVar.geometry.boardSize);
	    }

	}
	
	Model.Game.cbGetPieceTypes = function() {
		//var $this=this;
	
		var pTypes = [];
		
		var nullGraph = {};
		for(var pos=0;pos<this.cbVar.geometry.boardSize;pos++)
			nullGraph[pos]=[];

		this.cbMaxRanking = 0;
		
		for(var typeIndex in this.cbVar.pieceTypes) {
			var pType = this.cbVar.pieceTypes[typeIndex];
			var r = (pType.ranking ? pType.ranking : 0);
			if(r > this.cbMaxRanking) this.cbMaxRanking = r;
			pTypes[typeIndex] = {
				graph: pType.graph || nullGraph,
				abbrev: pType.abbrev || '',
				value: pType.value || (pType.isKing ? 100 : 1),
				isKing: pType.isKing || false,
				castle: !!pType.castle,
				epTarget: !!pType.epTarget,
				epCatch: !!pType.epCatch,
				ranking: r,
				antiTrade: pType.antiTrade || 0,
			}
		}
		
		return pTypes;
	}

	Model.Board.Init = function(aGame) {
		this.zSign=0;
	}

	Model.Board.cbPlacePieces = function(aGame) {

		var $this=this;

		this.pieces.sort(function(p1,p2) {
			if(p1.s!=p2.s)
				return p2.s-p1.s;
			var v1=aGame.cbVar.pieceTypes[p1.t].value || 100;
			var v2=aGame.cbVar.pieceTypes[p2.t].value || 100;
			if(v1!=v2)
				return v1-v2;
			return p1.p-p2.p;
		});

		this.zSign=aGame.wKey(0);
		for(var pos=0;pos<aGame.g.boardSize;pos++)
			this.board[pos]=-1;
		this.pieces.forEach(function(piece,index) {
			piece.i=index;
			if(piece.p<0) return;
			$this.board[piece.p]=index;
			var pType=aGame.g.pTypes[piece.t];
			if(pType.isKing)
				$this.kings[piece.s*pType.isKing]=piece.p;
			$this.zSign^=aGame.bKey(piece) ^ aGame.tKey(piece);
		});
		
	}

	Model.Board.InitialPosition = function(aGame) {
		var $this=gameState=this;
		if(USE_TYPED_ARRAYS)
			this.board=new Int16Array(aGame.g.boardSize);
		else
			this.board=[];
		this.kings={};
		this.pieces=[];
		this.ending={
			'1': false,
			'-1': false,
		}
		this.lastMove={  // (invalid) dummy, to make sure it exists...
			f: -1,
			t: 0,
			c: null, // ... and is not mistaken for a capture
		};
		if(aGame.cbVar.castle)
			this.castled={
				'1': false,
				'-1': false,
			}

		this.noCaptCount = this.check = this.oppoCheck = 0;
		this.mWho = 1;

		if(aGame.mInitial) {
			this.mWho = aGame.mInitial.turn || 1;
			aGame.mInitial.pieces.forEach(function(piece) {
				var piece1={}
				for(var f in piece)
					if(piece.hasOwnProperty(f))
						piece1[f]=piece[f];
				$this.pieces.push(piece1);
			});
			if(aGame.mInitial.lastMove)
				this.lastMove={
					f: aGame.mInitial.lastMove.f,
					t: aGame.mInitial.lastMove.t,
					c: aGame.mInitial.lastMove.c,
				}
			if(aGame.mInitial.noCaptCount!==undefined)
				this.noCaptCount=aGame.mInitial.noCaptCount;
			// NOTE: this.castled[who] is a plain boolean meaning "this side
			// has already castled" (see cbApplyCastle/cbGeneratePseudoLegalMoves:
			// `!this.check && !this.castled[who]` gates castle move generation
			// entirely, with no K/Q-side granularity). It must stay false/true,
			// never an object: an object is always truthy, so setting it to
			// {k,q} here - even {k:false,q:false} - silently disabled castling
			// completely for any position loaded from FEN/PJN, regardless of
			// the FEN's castling availability field. Per-side (K/Q) castling
			// rights are already correctly derived from each king/rook's
			// "moved" flag (piece.m), itself computed by Model.Game.Import()
			// by comparing FEN piece positions against the variant's nominal
			// initial setup - so there is nothing useful to initialize here:
			// this.castled keeps its default "false" (set above in InitBoard)
			// for any position loaded from FEN, exactly like a fresh game.
		} else {
			for(var typeIndex in aGame.cbVar.pieceTypes) {
				var pType = aGame.cbVar.pieceTypes[typeIndex];
				var initial = pType.initial || [];
				for(var i=0;i<initial.length;i++) {
					var desc = initial[i];
					var piece = {
						s: desc.s,
						t: parseInt(typeIndex),
						p: desc.p,
						m: false,
						r: aGame.g.pTypes[typeIndex].ranking,
					}
					this.pieces.push(piece);
				}
			}
		}

		this.cbPlacePieces(aGame);
		
		//console.log("sign",this.zSign);
		
		if(aGame.mInitial && aGame.mInitial.enPassant) {
			var pos=cbVar.geometry.PosByName(aGame.mInitial.enPassant);
			if(pos>=0) {
				var pos2;
				// TODO does not work for all geometries
				var c=cbVar.geometry.C(pos);
				var r=cbVar.geometry.R(pos);
				if(aGame.mInitial.turn==1)
					pos2=cbVar.geometry.POS(c,r-1);
				else
					pos2=cbVar.geometry.POS(c,r+1);
				this.epTarget={
					p: pos,
					i: this.board[pos2],
				}
			}
		}
	}

	Model.Board.CopyFrom = function(aBoard) {
		if(USE_TYPED_ARRAYS) {
			this.board=new Int16Array(aBoard.board.length);
			this.board.set(aBoard.board);
		} else {
			this.board=[];
			var board0=aBoard.board;
			var boardLength=board0.length;
			for(var i=0;i<boardLength;i++)
				this.board.push(board0[i]);
		}
		this.pieces=[];
		var piecesLength=aBoard.pieces.length;
		for(var i=0;i<piecesLength;i++) {
			var piece=aBoard.pieces[i];
			this.pieces.push({
				s: piece.s,
				p: piece.p,
				t: piece.t,
				i: piece.i,
				m: piece.m,
				r: piece.r,
			});
		}
		this.kings={};
		for(var i in aBoard.kings)
			this.kings[i] = aBoard.kings[i];
		this.check=aBoard.check;
		this.oppoCheck=aBoard.oppoCheck;
		this.lastMove={
			f: aBoard.lastMove.f,
			t: aBoard.lastMove.t,
			c: aBoard.lastMove.c,
		}
		this.ending={
			'1': aBoard.ending[1],
			'-1': aBoard.ending[-1],
		}
		if(aBoard.castled!==undefined) {
			this.castled= {
				'1': aBoard.castled[1],
				'-1': aBoard.castled[-1],
			}
		}
		this.noCaptCount=aBoard.noCaptCount;
		if(aBoard.epTarget)
			this.epTarget={
				p: aBoard.epTarget.p,
				i: aBoard.epTarget.i,
			}
		else
			this.epTarget=null;
		this.mWho=aBoard.mWho;
		this.zSign=aBoard.zSign;
	}

	Model.Board.cbApplyCastle = function(aGame,move,updateSign) {
		var spec=aGame.cbVar.castle[move.f+"/"+move.cg];
		var rookTo=spec.r[spec.r.length-1] + (move.t >> 16);
		var rPiece=this.pieces[this.board[move.cg]];
		var kingTo=move.t & 0xffff;
		var kPiece=this.pieces[this.board[move.f]];
		if(updateSign) {
			this.zSign^=aGame.bKey(rPiece);
			this.zSign^=aGame.bKey(kPiece);
		}
		
		rPiece.p=rookTo;
		rPiece.m=true;
		this.board[move.cg]=-1;
		
		kPiece.p=kingTo;
		kPiece.m=true;
		this.board[move.f]=-1;
		
		if(updateSign) {
			this.zSign^=aGame.bKey(rPiece);
			this.zSign^=aGame.bKey(kPiece);
		}
		
		this.board[rookTo]=rPiece.i;
		this.board[kingTo]=kPiece.i;
		this.castled[rPiece.s]=true;
		
		this.kings[kPiece.s]=kingTo;
		
		return [{
			i: rPiece.i,
			f: rookTo,
			t: -1,
		},{
			i: kPiece.i,
			f: kingTo,
			t: move.f,
			kp: move.f,
			who: kPiece.s,
			m: false,
		},{
			i: rPiece.i,
			f: -1,
			t: move.cg,
			m: false,
			cg: false,
		}];
	}
	
	Model.Board.cbQuickApply = function(aGame,move) {
		if(move.cg!==undefined)
			return this.cbApplyCastle(aGame,move,false);
		var undo=[];
		var index=this.board[move.f];
		var piece=this.pieces[index];
		if(move.c!=null) {
			undo.unshift({
				i: move.c,
				f: -1,
				t: this.pieces[move.c].p,
			});
			var piece1=this.pieces[move.c];
			this.board[piece1.p]=-1;
			piece1.p=-1;
		}
		undo.unshift({
			i: index,
			f: move.t,
			t: move.f,
			ty: piece.t,
		});
		piece.p=move.t;
		if(move.pr!==undefined)
			piece.t=move.pr;
		var royal = aGame.g.pTypes[piece.t].isKing;
		if(royal) {
			royal *= piece.s;
			undo[0].who=royal; // only add these fields when needed
			undo[0].kp=this.kings[royal];
			this.kings[royal]=move.t;
		}
		this.board[move.f]=-1;
		this.board[move.t]=index;

		return undo;
	}

	Model.Board.cbQuickUnapply = function(aGame,undo) {
		for(var i=0;i<undo.length;i++) {
			var u=undo[i];
			var piece=this.pieces[u.i];
			if(u.f>=0) {
				piece.p=-1;
				this.board[u.f]=-1;
			}
			if(u.t>=0) {
				piece.p=u.t;
				this.board[u.t]=u.i;
			}
			if(u.m!==undefined)
				piece.m=u.m;
			if(u.kp!==undefined)
				this.kings[u.who]=u.kp;
			if(u.ty!=undefined)
				piece.t=u.ty;
			if(u.cg!=undefined)
				this.castled[piece.s]=u.cg;
		}
	}

	Model.Board.ApplyMove = function(aGame,move) {
		var piece=this.pieces[this.board[move.f]];
		if(move.cg!==undefined)
			this.cbApplyCastle(aGame,move,true);
		else {
			this.zSign^=aGame.bKey(piece);
			this.board[piece.p]=-1;
			if(move.pr!==undefined) {
				this.zSign^=aGame.tKey(piece);
				piece.t=move.pr;
				this.zSign^=aGame.tKey(piece);
			}
			if(move.c!=null) {
				var piece1=this.pieces[move.c];
				this.zSign^=aGame.bKey(piece1);
				this.board[piece1.p]=-1;
				piece1.p=-1;
				piece1.m=true;
				this.noCaptCount=0;
			} else if(piece.t < aGame.cbPawnTypes)
				this.noCaptCount = 0;
			else
				this.noCaptCount++;
			piece.p=move.t;
			piece.m=true;
			this.board[move.t]=piece.i;
			this.zSign^=aGame.bKey(piece);
			var royal = aGame.g.pTypes[piece.t].isKing;
			if(royal)
				this.kings[piece.s*royal]=move.t;
		}
		var h=this.oppoCheck;
		this.oppoCheck=this.check;
		this.check=(move.ck ? h+1 : 0);
		this.lastMove={
			f: move.f,
			t: move.t,
			c: move.c,
		}
		if(move.ko!==undefined)
			this.ending[piece.s]=move.ko;
		if(move.ept!==undefined)
			this.epTarget={
				p: move.ept,
				i: piece.i,
			}
		else
			this.epTarget=null;
		this.zSign^=aGame.wKey(1); // side-to-move key
		//this.cbIntegrity(aGame);
	}

	Model.Board.Evaluate = function(aGame) {
		var debug=arguments[3]=="debug";
		var $this=this;
		this.mEvaluation=0;
		var who=this.mWho;
		var g=aGame.g;
		var material;
		if(USE_TYPED_ARRAYS)
			material={ 
				'1': {
					count: new Uint8Array(g.pTypes.length),
					byType: {},
				},
				'-1': {
					count: new Uint8Array(g.pTypes.length), 
					byType: {},
				}
			}
		else {
			material={ 
				'1': {
					count: [],
					byType: {},
				},
				'-1': {
					count: [], 
					byType: {},
				}
			}
			for(var i=0;i<g.pTypes.length;i++)
				material["1"].count[i]=material["-1"].count[i]=0;
		}
		
		if(aGame.mOptions.preventRepeat &&
			 aGame.GetRepeatOccurence(this)>=aGame.cbMaxRepeats) {
			if(typeof aGame.cbPerpEval == 'function')
				this.mWinner=aGame.cbPerpEval(this, aGame);
			else
				this.mWinner=aGame.cbOnPerpetual?who*aGame.cbOnPerpetual:JocGame.DRAW;
			this.mFinished=(this.mWinner !== undefined);
			return;
		}
		
		var pieceValue={ '1': 0, '-1': 0 };
		var distKingGraph={
			'1': g.distGraph[this.kings[-1]],
			'-1': g.distGraph[this.kings[1]],
		}
		var distKing={ '1': 0, '-1': 0 };
		var pieceCount={ '1': 0, '-1': 0 };
		var posValue={ '1': 0, '-1': 0 };
		
		var castlePiecesCount={ '1': 0, '-1': 0 };
		var kingMoved={ '1': 0, '-1': 0 }; // kludge: should become false or true
		
		var pieces=this.pieces;
		var piecesLength=pieces.length;
		for(var i=0;i<piecesLength;i++) {
			var piece=pieces[i];
			if(piece.p>=0) {
				var s=piece.s;
				var pType=g.pTypes[piece.t];
				if(!pType.isKing)
					pieceValue[s]+=pType.value;
				else
					kingMoved[s]=piece.m;
				if(pType.castle && !piece.m)
					castlePiecesCount[s]++;
				pieceCount[s]++;
				distKing[s]+=distKingGraph[s][piece.p];
				posValue[s]+=cbVar.geometry.distEdge[piece.p];
				var mat=material[s];
				mat.count[piece.t]++;
				var byType=mat.byType;
				if(byType[piece.t]===undefined)
					byType[piece.t]=[piece];
				else
					byType[piece.t].push(piece);					
			}
		}

		if(kingMoved[who]===0 && this.kings[who]!==undefined) { // no King found, but had one before
			this.mWinner=-who; this.mFinished=true; // opponent wins
			return;
		}
		
		if(this.lastMove.c!==null) {
			var piece=this.pieces[this.board[this.lastMove.t]];
			pieceValue[-piece.s]+=this.cbStaticExchangeEval(aGame,piece.p,piece.s,{piece:piece})
		}
		var kingFreedom={ '1': 0, '-1': 0 };
		var endingDistKing={ '1': 0, '-1': 0 };
		var distKingCorner={ '1': 0, '-1': 0 };
		function DistKingCorner(side) {
			var dist=Infinity;
			for(var corner in cbVar.geometry.corners) 
				dist=Math.min(dist,g.distGraph[$this.kings[side]][corner]);
			return dist-Math.sqrt(g.boardSize);
		}
		if(this.ending[1]) {
			//kingFreedom[1]=this.cbEvaluateKingFreedom(aGame,1)-g.boardSize;
			//endingDistKing[1]=g.distGraph[this.kings[-1]][this.kings[1]]-Math.sqrt(g.boardSize);
			endingDistKing[1]=(distKing['1']-Math.sqrt(g.boardSize))/pieceCount['1'];
			if(cbVar.geometry.corners)
				distKingCorner[1]=DistKingCorner(1);
		}
		if(this.ending[-1]) {
			//kingFreedom[-1]=this.cbEvaluateKingFreedom(aGame,-1)-g.boardSize;
			//endingDistKing[-1]=g.distGraph[this.kings[-1]][this.kings[1]]-Math.sqrt(g.boardSize);
			endingDistKing[-1]=(distKing['-1']-Math.sqrt(g.boardSize))/pieceCount['-1'];
			if(cbVar.geometry.corners)
				distKingCorner[1]=DistKingCorner(-1);
		}
		
		var evalValues={
			"pieceValue": pieceValue['1']-pieceValue[-1],
			"pieceValueRatio": (pieceValue['1']-pieceValue[-1])/(pieceValue['1']+pieceValue['-1']+1),
			"posValue": posValue['1']-posValue[-1],
			"averageDistKing": distKing['1']/pieceCount['1']-distKing['-1']/pieceCount[-1],
			"check": this.check?-who:0,
			"endingKingFreedom": kingFreedom[1]-kingFreedom[-1],
			"endingDistKing": endingDistKing['1']-endingDistKing['-1'],
			"distKingCorner": distKingCorner['1']-distKingCorner['-1'],
		}
		if(cbVar.castle)
			evalValues["castle"] = 
				(this.castled[1] ? 1 : (kingMoved[1]? 0 : castlePiecesCount[1] / (g.castleablePiecesCount[1]+1))) -  
				(this.castled[-1] ? 1 : (kingMoved[-1]? 0 : castlePiecesCount[-1] / (g.castleablePiecesCount[-1]+1)));
		
		if(cbVar.evaluate)
			cbVar.evaluate.call(this,aGame,evalValues,material,pieceCount,pieceValue);

		var evParams=aGame.mOptions.levelOptions;
		for(var name in evalValues) {
			var value=evalValues[name];
			var factor=evParams[name+'Factor'] || 0;
			var weighted=value*factor;
			if(debug)
				console.log(name,"=",value,"*",factor,"=>",weighted);
			this.mEvaluation+=weighted;
		}
		if(debug)
			console.log("Evaluation",this.mEvaluation);
	}
	
	Model.Board.cbGeneratePseudoLegalMoves = function(aGame) {
		var $this=this;
		var moves=[];
		var cbVar=aGame.cbVar;
		var who=this.mWho;
		var castlePieces=cbVar.castle && !this.check && !this.castled[who]?[]:null; // consider castle ?
		var king=-1;
		
		function PromotedMoves(piece,move) {
			var promoFnt=aGame.cbVar.promote;
			if(!promoFnt) {
				moves.push(move);
				return;
			}
			var promo=promoFnt.call($this,aGame,piece,move);
			if(promo==null)
				return;
			if(promo.length==0)
				moves.push(move);
			else if(promo.length==1) {
				move.pr=promo[0];
				moves.push(move);
			} else {
				for(var i=0;i<promo.length;i++) {
					var pr=promo[i];
					moves.push({
						f: move.f,
						t: move.t,
						c: move.c,
						pr: pr,
						ept: move.ept,
						ep: move.ep,
						a: move.a,
					});
				}
			}
		}

		var piecesLength=this.pieces.length;
		for(var i=0;i<piecesLength;i++) {
			var piece=this.pieces[i];
			if(piece.p<0 || piece.s!=who)
				continue;
			var pType=aGame.g.pTypes[piece.t];
			
			if(pType.isKing) {
				if(piece.m) // king moved, no castling
					castlePieces=null;
				else
					king=piece;
			} else if(pType.castle && !piece.m && castlePieces) // rook considered for castle
				castlePieces.push(piece);
			
			var graph, graphLength;
			graph=pType.graph[piece.p];
			graphLength=graph.length;
			for(var j=0;j<graphLength;j++) {
				var line=graph[j];
				var screen=false;
				var lineLength=line.length;
				var lastPos=piece.p;
				for(var k=0;k<lineLength;k++) {
					var tg1=line[k];
					var pos1=tg1 & MASK;
					var index1=this.board[pos1];
					var nonCapt=(index1<0);
					if(nonCapt && pType.epCatch && this.epTarget) { // destination empty, but could be e.p. capture
						var ept=this.epTarget.p;
						do {
							if(ept==pos1) { nonCapt=false; break; }
							ept+=this.epTarget.p-this.lastMove.t;
						} while(ept!=this.lastMove.f);
					}
					if(nonCapt) {
						if((tg1 & FLAG_MOVE) && screen==false)
							PromotedMoves(piece,{
								f: piece.p,
								t: pos1,
								c: null,
								a: pType.abbrev,
								ept: lastPos==piece.p || !pType.epTarget?undefined:lastPos,
							});
						else if(tg1 & FLAG_SPECIAL)
							this.specials.push({
								f: piece.p,
								t: pos1,
								c: null,
								a: pType.abbrev,
								x: tg1 ^ lastPos
							});
					} else if(tg1 & FLAG_SCREEN_CAPTURE) {
						var piece1=this.pieces[index1];
						if(screen || tg1 & FLAG_CAPTURE) { // direct capture might also be possible
							if(piece1.s!=piece.s)
								PromotedMoves(piece,{
									f: piece.p,
									t: pos1,
									c: piece1.i,
									a: pType.abbrev,
								});
							if(!piece.r && screen) break; // normal hoppers terminate after first screen capture
						}
						if(piece.r && (piece.r|1) <= piece1.r) break; // blocking power too large
						screen=true;
					} else {
						var piece1;
						if(index1<0)
							piece1=this.pieces[this.epTarget.i];
						else
							piece1=this.pieces[index1];
						if(tg1 & FLAG_CAPTURE) {
							if(piece1.s!=piece.s && !(tg1 & (aGame.g.pTypes[piece1.t].isKing ? FLAG_CAPTURE_NO_KING : FLAG_CAPTURE_KING)))
								PromotedMoves(piece,{
									f: piece.p,
									t: pos1,
									c: piece1.i,
									a: pType.abbrev,
									ep: index1<0,
								});
						} else if(tg1 & (FLAG_CAPTURE_SELF | FLAG_SPECIAL_CAPTURE)) {
							if(tg1 & (piece1.s==piece.s ? FLAG_CAPTURE_SELF : FLAG_SPECIAL_CAPTURE))
							this.specials.push({
								f: piece.p,
								t: pos1,
								c: piece1.i,
								a: pType.abbrev,
								x: tg1 ^ lastPos
							});
						}
						break;
					}
					lastPos=pos1;
				}
			}
		}
		
		if(castlePieces) {
			for(var i=0;i<castlePieces.length;i++) {
				var rook=castlePieces[i];
				var spec=aGame.cbVar.castle[king.p+"/"+rook.p];
				if(!spec)
					continue;
				var rookOk=true;
				for(var j=0;j<spec.r.length;j++) {
					var pos=spec.r[j];
					if(this.board[pos]>=0 && pos!=king.p && pos!=rook.p) {
						rookOk=false;
						break;
					}
				}
				if(rookOk) {
					var step=(rook.p>king.p ? 1 : -1);
					var last=spec.k.length-1; // nominal King destination found here
					var extra=spec.extra || 0;
					var d=0;
					if(extra<0) extra*=-1,d=1;
					for(var j=0;j<=last+extra;j++) { // allow optional extension of King move
						var pos=(j<last ? spec.k[j] : spec.k[last]+step*(j-last));
						if((this.board[pos]>=0 && pos!=rook.p && pos!=king.p) || this.cbGetAttackers(aGame,pos,who).length>0) {
							break;
						}
						if(j>=last+d) {
							move={
								f: king.p,
								t: pos | step*(j-last)<<16,
								c: null,
								cg: rook.p,
							}
							if(j>last) move.a=pType.abbrev;
							moves.push(move);
						}
					}
				}
			}
		}
		
		return moves;
	}
	
	// Static Exchange Evaluation, as per http://chessprogramming.wikispaces.com/Static+Exchange+Evaluation
	Model.Board.cbStaticExchangeEval = function(aGame,pos,side,lastCaptured) {
		var value=0;
		var piece1=this.cbGetSmallestAttacker(aGame,pos,side);
		if(piece1) {
			var who=this.mWho;
			this.mWho=piece1.s;
			var undo=this.cbQuickApply(aGame,{
				f: piece1.p,
				t: pos,
				c: lastCaptured.piece.i,
			});
			var lastCapturedValue=aGame.g.pTypes[lastCaptured.piece.t].value;
			lastCaptured.piece=piece1;
			value=Math.max(0,lastCapturedValue-this.cbStaticExchangeEval(aGame,pos,-side,lastCaptured));
			this.cbQuickUnapply(aGame,undo);
			//this.cbIntegrity(aGame);
			this.mWho=who;
		}
		return value;		
	}
	
	Model.Board.cbGetSmallestAttacker = function(aGame,pos,side) {
		var attackers=this.cbGetAttackers(aGame,pos,side);
		if(attackers.length==0)
			return null;
		var smallestValue=Infinity;
		var smallestAttacker=null;
		var attackersLength=attackers.length;
		for(var i=0;i<attackersLength;i++) {
			var attacker=attackers[i];
			var attackerValue=aGame.g.pTypes[attacker.t].value;
			if(attackerValue<smallestValue) {
				smallestValue=attackerValue;
				smallestAttacker=attacker;
			} 
		}
		return smallestAttacker;
	}

	Model.Board.cbCollectAttackers=function(who,graph,attackers,isKing) {
		for(var pos1 in graph) {
			var branch=graph[pos1];
			var index1=this.board[pos1];
			if(index1<0)
				this.cbCollectAttackers(who,branch.e,attackers,isKing);
			else {
				var piece1=this.pieces[index1];
				if(piece1.s==-who && (
						(branch.t && (piece1.t in branch.t)) ||
						(isKing && branch.tk && (piece1.t in branch.tk))))
					attackers.push(piece1);
			}
		}
	}

	var mr;

	Model.Board.cbCollectAttackersScreen=function(who,graph,attackers,isKing,screen) {
		for(var pos1 in graph) {
			var branch=graph[pos1];
			var index1=this.board[pos1];
			if(index1<0)
				this.cbCollectAttackersScreen(who,branch.e,attackers,isKing,screen);
			else {
				var piece1=this.pieces[index1];
				if(!screen) {
					if(piece1.s==-who && (
						(branch.t && (piece1.t in branch.t)) ||
						(isKing && branch.tk && (piece1.t in branch.tk))))
						attackers.push(piece1); // direct attacker
				 	this.cbCollectAttackersScreen(who,branch.e,attackers,isKing,piece1.r|1024); // 1024 bit: must jump 1 screen
				} else {
					if(piece1.s==-who && branch.ts && (piece1.t in branch.ts) &&
					   (piece1.r ? (piece1.r|1) > (screen&1023) : screen&1024)) // normal hopper: 1 screen, ranked must top highest screen
						attackers.push(piece1);
					if(!mr) continue; // no flying pieces in this game
					var s=screen&1023; // we now have multiple screens
					if(piece1.r > s) s=piece1.r; // this target screens better
					if(s < (mr|1)) // but not maximally
					 	this.cbCollectAttackersScreen(who,branch.e,attackers,isKing,s|2048);
				}
			}
		}
	}

	Model.Board.cbGetAttackers = function(aGame,pos,who,isKing) {
		var attackers=[];
		mr = aGame.cbMaxRanking;
		if(aGame.cbUseScreenCapture)
			this.cbCollectAttackersScreen(who,aGame.g.threatGraph[who][pos],attackers,isKing,0);
		else
			this.cbCollectAttackers(who,aGame.g.threatGraph[who][pos],attackers,isKing);
		return attackers;
	}

	Model.Board.GenerateMoves = function(aGame) {
		var moves=this.cbGeneratePseudoLegalMoves(aGame);
		this.mMoves = [];
		var kingOnly=true;
		var selfKingPos=this.kings[this.mWho];
		var movesLength=moves.length;
		for(var i=0;i<movesLength;i++) {
			var move=moves[i];
			var undo=this.cbQuickApply(aGame,move);
			var inCheck=this.cbGetAttackers(aGame,this.kings[this.mWho],this.mWho,100).length>0;
			if(!inCheck) {
				var oppInCheck=this.cbGetAttackers(aGame,this.kings[-this.mWho],-this.mWho,100).length>0;
				move.ck = oppInCheck; 
				this.mMoves.push(move);
				if(move.f!=selfKingPos)
					kingOnly=false;
			}
			this.cbQuickUnapply(aGame,undo);
		}
		if(this.mMoves.length==0) {
			this.mFinished=true;
			this.mWinner=aGame.cbOnStaleMate?aGame.cbOnStaleMate*this.mWho:JocGame.DRAW;
			if(this.check)
				this.mWinner=(aGame.cbMateEval ? aGame.cbMateEval(this) : -this.mWho);
		} else if(this.ending[this.mWho]) {
			if(!kingOnly) {
				for(var i=0;i<this.mMoves.length;i++)
					this.mMoves[i].ko=false;
			}
		} else if(!this.ending[this.mWho]) {
			if(kingOnly && !this.check) {
				for(var i=0;i<this.mMoves.length;i++)
					this.mMoves[i].ko=true;
			}
		}
	}

	Model.Board.GetSignature = function() {
		return this.zSign;
	}

	Model.Move.Init = function(args) {
		for(var f in args)
			if(args.hasOwnProperty(f))
				this[f]=args[f];
	}

	Model.Move.Equals = function(move) {
		return this.f==move.f && this.t==move.t && this.pr==move.pr;
	}
	
	Model.Move.CopyFrom=function(move) {
		this.Init(move);
	}

	Model.Move.ToString = function(format) {

		var self = this;
		format = format || "natural";

		// not sure was that was for...
		//if(this.compact)
		//	return this.compact;
		function NaturalFormat() {
			var str;
			if(self.cg!==undefined) {
				if(self.t>>16) str=self.a+cbVar.geometry.PosName(self.f)+'~'+cbVar.geometry.PosName(self.t&0xffff);
				else str=cbVar.castle[self.f+"/"+self.cg].n;
			} else {
				str=self.a || '';
				str+=cbVar.geometry.PosName(self.f);
				if(self.c==null)
					str+="-";
				else
					str+="x";
				str+=cbVar.geometry.PosName(self.t);
			}
			if(self.pr!==undefined) {
				var pType=cbVar.pieceTypes[self.pr];
				if(pType && pType.abbrev && pType.abbrev.length>0 && !pType.silentPromo)
					str+="="+pType.abbrev;
			}
			if(self.ck)
				str+="+";
			return str;
		}

		function EngineFormat() {
			var str = cbVar.geometry.PosName(self.f) + cbVar.geometry.PosName(self.t&0xffff);
			if(self.pr!=undefined) {
				var pType=cbVar.pieceTypes[self.pr];
				if(pType && pType.abbrev && pType.abbrev.length>0 && !pType.silentPromo)
					str+=pType.abbrev;				
			}
			return str;
		}

		// Like EngineFormat(), but for engines running with UCI_Chess960
		// enabled, where castling moves must use "king takes own rook"
		// notation (e.g. "g1h1") rather than the king's actual destination
		// square (e.g. "g1g1" - meaningless - or "e1g1" in the general
		// case). This is the de facto UCI standard for Chess960 castling
		// (see e.g. https://github.com/fairy-stockfish/chess-variant-standards
		// or python-chess's Board.uci(chess960=True)); it must NOT be used
		// as the default "engine" format because it would silently break
		// move-matching for every other (non-Chess960) game with castling -
		// the "king takes rook" destination is closer, in plain Levenshtein
		// distance, to unrelated short moves landing near the rook's
		// square than to the actual matching move in "engine" format. Only
		// use this format when the engine was actually told
		// "setoption name UCI_Chess960 value true" for this search (see
		// jocly.fairy.js's "chess960" level option).
		function Engine960Format() {
			if(self.cg===undefined)
				return EngineFormat();
			var str = cbVar.geometry.PosName(self.f) + cbVar.geometry.PosName(self.cg);
			if(self.pr!=undefined) {
				var pType=cbVar.pieceTypes[self.pr];
				if(pType && pType.abbrev && pType.abbrev.length>0 && !pType.silentPromo)
					str+=pType.abbrev;
			}
			return str;
		}
		
		switch(format) {
			case "natural":
				return NaturalFormat();
			case "engine":
				return EngineFormat();
			case "engine960":
				return Engine960Format();
			default:
				return "??";
		}


	}
	
	/* compact the move notation while preventing ambiguities */
	Model.Board.CompactMoveString = function(aGame,aMove,allMoves) {
		if(typeof aMove.ToString!="function") // ensure proper move object, if necessary
			aMove=aGame.CreateMove(aMove);
		var moveStr=aMove.ToString();
		var m=/^([A-Z]?)([a-z])([1-9][0-9]*)([-x])([a-z])([1-9][0-9]*)(.*?)$/.exec(moveStr);
		if(!m)
			return moveStr;
		var moveSuffix=m[7];

		if(!allMoves)
			allMoves={};
		if(!allMoves.value)
			allMoves.value=[];
		if(allMoves.value.length==0) {
			var oldMoves=this.mMoves;
			if(!this.mMoves || this.mMoves.length==0)
				this.GenerateMoves(aGame);
			for(var i=0;i<this.mMoves.length;i++) {
				var move=this.mMoves[i];
				if(typeof move.ToString!="function") // ensure proper move object, if necessary
					move=aGame.CreateMove(move);
				allMoves.value.push({
					str: move.ToString(),
					move: move,
				});
			}
			this.mMoves=oldMoves;
		}
		var matching=[];
		allMoves.value.forEach(function(mv) {
			var m2=/^([A-Z]?[a-z][1-9][0-9]*[-x][a-z][1-9][0-9]*)(.*?)$/.exec(mv.str);
			if(m2) {
				if(mv.move.t==aMove.t && (mv.move.a || '')==m[1] && m2[2]==moveSuffix) {
					matching.push(mv.move);
				}
			}			
		});

		if(matching.length==1) {
			if(m[1]=='' && m[4]=='x')
				return m[2]+'x'+m[5]+m[6]+m[7];
			else
				return m[1]+(m[4]=='x'?'x':'')+m[5]+m[6]+m[7];
		}
		if(cbVar.geometry.CompactCrit) {
			var crit="";
			for(var i=0;;i++) {
				var from2=cbVar.geometry.CompactCrit(aMove.f,i);
				if(from2==null)
					return moveStr;
				crit+=from2;
				var matching2=[];
				for(var j=0;j<matching.length;j++) {
					var move2=matching[j];
					if(cbVar.geometry.CompactCrit(move2.f,i)==from2)
						matching2.push(move2);
				}

				console.assert(matching2.length>0);
				if(matching2.length==1)
					return m[1]+crit+(m[4]=='x'?'x':'')+m[5]+m[6]+m[7];
				matching=matching2;
			}
		}
		return moveStr;
	}
	
	Model.Board.cbIntegrity = function(aGame) {
		var $this=this;
		function Assert(cond,text) {
			if(!cond) {
				console.error(text);
				debugger;
			}
		}
		for(var pos=0;pos<this.board.length;pos++) {
			var index=this.board[pos];
			if(index>=0) {
				var piece=$this.pieces[index];
				Assert(piece!==undefined,"no piece at pos");
				Assert(piece.p==pos,"piece has different pos");
			}
		}
		for(var index=0;index<this.pieces.length;index++) {
			var piece=this.pieces[index];
			if(piece.p>=0) {
				Assert($this.board[piece.p]==index,"board index mismatch");
			}
		}
	}

	Model.Board.ExportBoardState = function(aGame) {
		if(!aGame.cbVar.geometry.ExportBoardState)
			return "not supported";
		return aGame.cbVar.geometry.ExportBoardState(this,aGame.cbVar,aGame.mPlayedMoves.length);
	}

	Model.Game.Import = function(format,data) {
		var turn, pieces=[], castle={'1':{},'-1':{}}, enPassant=null, noCaptCount=0;

		if(format=='pjn') {
			var result={
				status: false,
				error: 'parse',
			}
			var fenParts=data.split(' ');
			if(fenParts.length!=6) {
				console.warn("FEN should have 6 parts");
				return result;
			}
			var fenRows=fenParts[0].split('/');
			var fenHeight = cbVar.geometry.fenHeight || cbVar.geometry.height;
			if(fenRows.length!=fenHeight) {
				console.warn("FEN board should have",fenHeight,"rows, got",fenRows.length);
				return result;
			}
			
			var piecesMap={}
			
			for(var index in cbVar.pieceTypes) {
				var pType=cbVar.pieceTypes[index];
				var abbrev=pType.fenAbbrev || pType.abbrev || 'X';
				piecesMap[abbrev.toUpperCase()]={
					s: 1,
					t: index,
				}
				piecesMap[abbrev.toLowerCase()]={
					s: -1,
					t: index,
				}
			}
			
			var FenRowPos = cbVar.geometry.FenRowPos || function(rowIndex,colIndex) {
				return (cbVar.geometry.height-1-rowIndex)*cbVar.geometry.width+colIndex;
			}
			
			// TODO row/col does not fit all geometries
			fenRows.forEach(function(row,rowIndex) {
				var colIndex=0;
				for(var i=0;i<row.length;i++) {
					var ch=row.substr(i,1);
					var pieceDescr=piecesMap[ch];
					if(pieceDescr!==undefined) {
						var pos=FenRowPos(rowIndex,colIndex);
						colIndex++;
						var piece={
							s: pieceDescr.s,
							t: pieceDescr.t,
							p: pos,
						}
						var moved=true;
						var initial1=cbVar.pieceTypes[piece.t].initial || [];
						for(var j=0;j<initial1.length;j++) {
							var desc=initial1[j];
							if(desc.s==piece.s && desc.p==pos)
								moved=false;
						}
						piece.m=moved;
						pieces.push(piece);
					} else if(!isNaN(parseInt(ch))) 
						colIndex+=parseInt(ch);
					else {
						console.warn("FEN invalid board spec",ch);
						return result;
					}
				}
			});
			pieces.sort(function(p1,p2) {
				return p2.s-p1.s;
			});
			if(fenParts[1]=='w')
				turn=1;
			else if(fenParts[1]=='b')
				turn=-1;
			else {
				console.warn("FEN invalid turn spec",fenParts[1]);
				return result;
			}
			castle[1].k=fenParts[2].indexOf('K')>=0;
			castle[1].q=fenParts[2].indexOf('Q')>=0;
			castle[-1].k=fenParts[2].indexOf('k')>=0;
			castle[-1].q=fenParts[2].indexOf('q')>=0;
			enPassant=fenParts[3]=='-'?null:fenParts[3];
			var noCaptCount1=parseInt(fenParts[4]);
			if(!isNaN(noCaptCount1))
				noCaptCount=noCaptCount1;
			
			var initial={
				pieces: pieces,
				turn: turn,
				castle: castle,
				enPassant: enPassant,
				noCaptCount: noCaptCount,
			}
			var status=true;
			if(cbVar.importGame)
				cbVar.importGame.call(this,initial,format,data);
			
			return {
				status: status,
				initial: initial,
			}
		}
		return {
			status: false,
			error: 'unsupported',
		}
	}

	
})();


(function() {
	
	Model.Game.cbBoardGeometryCylinder = function(width,height) {

		var boardSize = width*height;
		
		function C(pos) {
			return pos%width;
		}
		function R(pos) {
			return Math.floor(pos/width);
		}
		function POS(c,r) {
			return r*width+c;
		}
		function Graph(pos,delta) {
			var c0=C(pos);
			var r0=R(pos);
			var c=c0+delta[0]
			while(c<0)
				c+=width;
			c%=width;
			var r=r0+delta[1];
			if(r<0 || r>=height)
				return null;
			return POS(c,r);
		}
		
		var distance={};
		for(var pos=0;pos<boardSize;pos++) {
			distance[pos]={};
			distance[pos][pos]=0;
		}
		var steps=[[1,-1],[1,0],[1,1],[0,-1],[0,1],[-1,-1],[-1,0],[-1,-1]];
		var modifs=true;
		while(modifs) {
			modifs=false;
			for(var pos=0;pos<boardSize;pos++) {
				steps.forEach(function(delta) {
					var pos1=Graph(pos,delta);
					if(pos1==null)
						return;
					if(distance[pos][pos1]!=1) {
						distance[pos][pos1]=1;
						distance[pos1][pos]=1;
						modifs=true;
					} 
					for(var pos2=0;pos2<boardSize;pos2++) {
						if(pos2==pos)
							continue;
						if(distance[pos1][pos2]===undefined && distance[pos][pos2]!==undefined) {
							distance[pos1][pos2]=distance[pos][pos2]+1;
							distance[pos2][pos1]=distance[pos][pos2]+1;
							modifs=true;
						} else if(distance[pos1][pos2]!==undefined && distance[pos][pos2]!==undefined && distance[pos1][pos2]>distance[pos][pos2]+1) {
							distance[pos1][pos2]=distance[pos][pos2]+1;
							distance[pos2][pos1]=distance[pos][pos2]+1;
							modifs=true;
						}
					}
				});
			}
		}
		
		var distEdges={};
		var modifs=true;
		while(modifs) {
			modifs=false;
			for(var pos=0;pos<boardSize;pos++) {
				if(pos in distEdges)
					continue;
				steps.forEach(function(delta) {
					var pos1=Graph(pos,delta);
					if(pos1==null)
						distEdges[pos]=1;
					else if(pos1 in distEdges) {
						if(!(pos in distEdges) || distEdges[pos]>distEdges[pos1]+1) {
							distEdges[pos]=distEdges[pos1]+1;
							modifs=true;
						}
					}
				});
			}
		}
		
		function PosName(pos) {
			 return String.fromCharCode(("a".charCodeAt(0))+C(pos)) + (R(pos)+1);
		}
		function PosByName(str) {
			var m=/^([a-z])([0-9]+)$/.exec(str);
			if(!m)
				return -1;
			var c=m[1].charCodeAt(0)-"a".charCodeAt(0);
			var r=parseInt(m[2])-1;
			return POS(c,r);
		}
		function CompactCrit(pos,index) {
			if(index==0)
				return String.fromCharCode(("a".charCodeAt(0))+C(pos));
			else if(index==1)
				return (R(pos)+1);
			else
				return null;
		}
		function GetDistances() {
			return distance;
		}
		
		return {
			boardSize: boardSize,
			width: width,
			height: height,
			C: C,
			R: R,
			POS: POS,
			Graph: Graph, 
			PosName: PosName,
			PosByName: PosByName,
			CompactCrit: CompactCrit,
			GetDistances: GetDistances,
			distEdge: distEdges,
			corners: null,
		};
	}

	/*
 	Piece graph: [ directions ]
 	Direction: [ Targets ]
 	Target: <position> | <flags bitmask>
 	<position>: 0xffff (invalid) or next position
	*/
	
	Model.Game.cbPawnGraph = function(geometry,side) {
		var $this=this;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			var directions=[];
			var pos1=geometry.Graph(pos,[0,side]);
			if(pos1!=null)
				directions.push($this.cbTypedArray([pos1 | $this.cbConstants.FLAG_MOVE]));
			[-1,1].forEach(function(dc) {
				var pos2=geometry.Graph(pos,[dc,side]);
				if(pos2!=null)
					directions.push($this.cbTypedArray([pos2 | $this.cbConstants.FLAG_CAPTURE]));				
			});
			graph[pos]=directions;
		}
		return graph;
	}
		
	Model.Game.cbInitialPawnGraph = function(geometry,side) {
		var $this=this;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			var directions=[];
			var pos1=geometry.Graph(pos,[0,side]);
			if(pos1!=null) {
				var direction=[pos1 | $this.cbConstants.FLAG_MOVE];
				var pos2=geometry.Graph(pos1,[0,side]);
				if(pos2!=null)
					direction.push(pos2 | $this.cbConstants.FLAG_MOVE);
				directions.push($this.cbTypedArray(direction));
			}
			[-1,1].forEach(function(dc) {
				var pos2=geometry.Graph(pos,[dc,side]);
				if(pos2!=null)
					directions.push($this.cbTypedArray([pos2 | $this.cbConstants.FLAG_CAPTURE]));				
			});
			graph[pos]=directions;
		}
		return graph;
	}

	Model.Game.cbKingGraph = function(geometry) {
		return this.cbShortRangeGraph(geometry,[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]);
	}

	Model.Game.cbKnightGraph = function(geometry) {
		return this.cbShortRangeGraph(geometry,[[2,-1],[2,1],[-2,-1],[-2,1],[-1,2],[-1,-2],[1,2],[1,-2]]);
	}

	Model.Game.cbHorseGraph = function(geometry) {
		var $this=this;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos]=[];
			[[1,0,2,-1],[1,0,2,1],[-1,0,-2,-1],[-1,0,-2,1],[0,1,-1,2],[0,-1,-1,-2],[0,1,1,2],[0,-1,1,-2]].forEach(function(desc) {
				var pos1=geometry.Graph(pos,[desc[0],desc[1]]);
				if(pos1!=null) {
					var pos2=geometry.Graph(pos,[desc[2],desc[3]]);
					if(pos2!=null)
						graph[pos].push($this.cbTypedArray([pos1 | $this.cbConstants.FLAG_STOP, pos2 | $this.cbConstants.FLAG_MOVE | $this.cbConstants.FLAG_CAPTURE]));
				}
			});
		}
		return graph;
	}

	
	Model.Game.cbRookGraph = function(geometry) {
		return this.cbLongRangeGraph(geometry,[[0,-1],[0,1],[-1,0],[1,0]]);
	}
	
	Model.Game.cbBishopGraph = function(geometry) {
		return this.cbLongRangeGraph(geometry,[[1,-1],[1,1],[-1,1],[-1,-1]]);
	}
	
	Model.Game.cbQueenGraph = function(geometry) {
		return this.cbLongRangeGraph(geometry,[[0,-1],[0,1],[-1,0],[1,0],[1,-1],[1,1],[-1,1],[-1,-1]]);
	}

	Model.Game.cbXQGeneralGraph = function(geometry,confine) {
		var $this=this;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos]=[];
			[[-1,0,false],[0,-1,true],[0,1,true],[1,0,false]].forEach(function(delta) {
				var direction=[];
				var pos1=geometry.Graph(pos,delta);
				if(pos1!=null) {
					if(!confine || (pos1 in confine))
					direction.push(pos1 | $this.cbConstants.FLAG_MOVE | $this.cbConstants.FLAG_CAPTURE);
					if(delta[2]) {
						var pos2=geometry.Graph(pos1,delta);
						while(pos2!=null) {
							if(!confine || (pos2 in confine))
								direction.push(pos2 | $this.cbConstants.FLAG_CAPTURE | $this.cbConstants.FLAG_CAPTURE_KING);
							else
								direction.push(pos2 | $this.cbConstants.FLAG_STOP);
							pos2=geometry.Graph(pos2,delta);
						}
					}
				}
				if(direction.length>0)
					graph[pos].push($this.cbTypedArray(direction));
			});
		}
		return graph;
	}
	
	Model.Game.cbXQSoldierGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[0,side]]);
	}

	Model.Game.cbXQPromoSoldierGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[0,side],[-1,0],[1,0]]);
	}

	Model.Game.cbXQAdvisorGraph = function(geometry,confine) {
		return this.cbShortRangeGraph(geometry,[[1,1],[-1,1],[1,-1],[-1,-1]],confine);
	}

	Model.Game.cbXQCannonGraph = function(geometry) {
		return this.cbLongRangeGraph(geometry,[[0,-1],[0,1],[-1,0],[1,0]],null,this.cbConstants.FLAG_MOVE | this.cbConstants.FLAG_SCREEN_CAPTURE);
	}
	
	Model.Game.cbXQElephantGraph = function(geometry,confine) {
		var $this=this;
		var graph={};
		for(var pos=0;pos<geometry.boardSize;pos++) {
			graph[pos]=[];
			if(confine && !(pos in confine))
				continue;
			[[1,1,2,2],[1,-1,2,-2],[-1,1,-2,2],[-1,-1,-2,-2]].forEach(function(desc) {
				var pos1=geometry.Graph(pos,[desc[0],desc[1]]);
				if(pos1!=null) {
					var pos2=geometry.Graph(pos,[desc[2],desc[3]]);
					if(pos2!=null && (!confine || (pos2 in confine)))
						graph[pos].push($this.cbTypedArray([pos1 | $this.cbConstants.FLAG_STOP, pos2 | $this.cbConstants.FLAG_MOVE | $this.cbConstants.FLAG_CAPTURE]));
				}
			});
		}
		return graph;
	}
	
	Model.Game.cbSilverGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[0,side],[-1,-1],[-1,1],[1,-1],[1,1]]);
	}
	
	Model.Game.cbFersGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[-1,-1],[-1,1],[1,-1],[1,1]]);
	}	

	Model.Game.cbElephantGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[-2,-2],[-2,2],[2,-2],[2,2]]);
	}	

	Model.Game.cbSchleichGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[-1,0],[1,0],[0,-1],[0,1]]);
	}	
	
	Model.Game.cbAlfilGraph = function(geometry,side) {
		return this.cbShortRangeGraph(geometry,[[-2,-2],[-2,2],[2,2],[2,-2]]);
	}	

	Model.Game.cbCylinderRookGraph = function(geometry) {
		return this.cbLongRangeGraph(geometry,[[0,-1],[0,1],[-1,0],[1,0]],null,null,Math.max(geometry.width,geometry.height)-1);
	}

	Model.Game.cbCircularPawnGraph = function(geometry,cc,range) {
		var moveGraph = this.cbLongRangeGraph(geometry,cc?[[1,0]]:[[-1,0]],null,this.cbConstants.FLAG_MOVE,range);
		var captGraph = this.cbShortRangeGraph(geometry,cc?[[1,1],[1,-1]]:[[-1,1],[-1,-1]],null,this.cbConstants.FLAG_CAPTURE);
		return this.cbMergeGraphs(geometry,moveGraph,captGraph);
	}
	
})();


(function() {
	
	var geometry = Model.Game.cbBoardGeometryCylinder(16,4);
	
	var promo = {
		"1": { 11:1, 27:1, 43:1, 59:1, 12:1, 28:1, 44:1, 60:1 },
		"-1": { 52:1, 36:1, 20:1, 4:1, 51:1, 35:1, 19:1, 3:1 },
	}
	
	// for each side and position, calculate distance to promotion line
	var distPromo={	"1": {}, "-1": {} };
	var distance = geometry.GetDistances();
	["1","-1"].forEach(function(side) {
		for(var pos in geometry.confine) {
			var minDist=Infinity;
			for(var pos1 in promo[side]) {
				var dist=distance[pos][pos1];
				if(dist<minDist) {
					distPromo[side][pos]=dist;
					minDist=dist;
				}
			}
		}		
	});
	
	Model.Game.cbDefine = function() {
		
		return {
			
			geometry: geometry,
			
			pieceTypes: {

				0: {
					name: 'pawn-cw',
					aspect: 'pawn',
					graph: this.cbCircularPawnGraph(geometry,true,1),
					value: 1,
					abbrev: '',
					fenAbbrev: 'P',
				},
				
				1: {
					name: 'ipawn-cw',
					aspect: 'pawn',
					graph: this.cbCircularPawnGraph(geometry,true,2),
					value: 1,
					abbrev: '',
					fenAbbrev: 'P',
					initial: [{s:1,p:5},{s:1,p:21},{s:1,p:37},{s:1,p:53},{s:-1,p:13},{s:-1,p:29},{s:-1,p:45},{s:-1,p:61}],
				},
				
				2: {
					name: 'pawn-ccw',
					aspect: 'pawn',
					graph: this.cbCircularPawnGraph(geometry,false,1),
					value: 1,
					abbrev: '',
					fenAbbrev: 'P',
				},

				3: {
					name: 'ipawn-ccw',
					aspect: 'pawn',
					graph: this.cbCircularPawnGraph(geometry,false,2),
					value: 1,
					abbrev: '',
					fenAbbrev: 'P',
					initial: [{s:1,p:2},{s:1,p:18},{s:1,p:34},{s:1,p:50},{s:-1,p:10},{s:-1,p:26},{s:-1,p:42},{s:-1,p:58}],
				},
				
				4: {
					name: 'knight',
					graph: this.cbKnightGraph(geometry),
					value: 2.9,
					abbrev: 'N',
					initial: [{s:1,p:20},{s:1,p:19},{s:-1,p:27},{s:-1,p:28}],
				},
				
				5: {
					name: 'bishop',
					graph: this.cbBishopGraph(geometry),
					value: 3.1,
					abbrev: 'B',
					initial: [{s:1,p:36},{s:1,p:35},{s:-1,p:43},{s:-1,p:44}],
				},

				6: {
					name: 'rook',
					graph: this.cbCylinderRookGraph(geometry),
					value: 5,
					abbrev: 'R',
					initial: [{s:1,p:4},{s:1,p:3},{s:-1,p:11},{s:-1,p:12}],
					castle: true,
				},

				7: {
					name: 'queen',
					graph: this.cbMergeGraphs(geometry,this.cbCylinderRookGraph(geometry),this.cbBishopGraph(geometry)),
					value: 9,
					abbrev: 'Q',
					initial: [{s:1,p:51},{s:-1,p:60}],
				},
				
				8: {
					name: 'king',
					isKing: true,
					graph: this.cbKingGraph(geometry),
					abbrev: 'K',
					initial: [{s:1,p:52},{s:-1,p:59}],
				},
				
			},
			
			promote: function(aGame,piece,move) {
				if(piece.t==1)
					return [0];
				else if(piece.t==3)
					return [2];
				else if(piece.s==1 && (piece.t==0 || piece.t==2) && (move.t in promo[1]))
					return [4,5,6,7];
				else if(piece.s==-1 && (piece.t==0 || piece.t==2) && (move.t in promo[-1]))
					return [4,5,6,7];
				return [];
			},

			evaluate: function(aGame,evalValues,material) {
				
				// check lack of material to checkmate
				var white=material[1].count;
				var black=material[-1].count;
				if(!white[0] && !white[1] && !white[4] && !white[5] && !white[6] && !white[7]) { // white king single
					if(!black[2] && !black[3] && !black[6] && !black[7] && (black[4]+black[5]<2 || black[5]<2)) {
						this.mFinished=true;
						this.mWinner=JocGame.DRAW;
					}
				}
				if(!black[2] && !black[3] && !black[4] && !black[5] && !black[6] && !black[7]) { // black king single
					if(!white[0] && !white[1] && !white[6] && !white[7] && (white[4]+white[5]<2 || white[5]<2)) {
						this.mFinished=true;
						this.mWinner=JocGame.DRAW;
					}
				}
				
				// check 50 moves without capture
				if(this.noCaptCount>=100) {
					this.mFinished=true;
					this.mWinner=JocGame.DRAW;					
				}
				
				// motivate pawns to reach the promotion line
				var distPromo0=aGame.cbUseTypedArrays?new Int8Array(3):[0,0,0];
				var pawns=material[1].byType[0],pawnsLength;
				if(pawns) {
					pawnsLength=pawns.length;
					for(var i=0;i<pawnsLength;i++) {
						var dProm=distPromo[1][pawns[i].p];
						if(dProm>0 && dProm<4)
							distPromo0[dProm-1]++;
					}
				}
				pawns=material[-1].byType[2],pawnsLength;
				if(pawns) {
					pawnsLength=pawns.length;
					for(var i=0;i<pawnsLength;i++) {
						var dProm=distPromo[-1][pawns[i].p];
						if(dProm>0 && dProm<4)
							distPromo0[dProm-1]--;
					}
				}
				if(distPromo0[0]!=0)
					evalValues['distPawnPromo1']=distPromo0[0];
				if(distPromo0[1]!=0)
					evalValues['distPawnPromo2']=distPromo0[1];
				if(distPromo0[2]!=0)
					evalValues['distPawnPromo3']=distPromo0[2];
				
				// motivate knights and bishops to deploy early
				var minorPiecesMoved=0;
				for(var t=4;t<=5;t++)
					for(var s=1;s>=-1;s-=2) {
						var pieces=material[s].byType[t];
						if(pieces)
							for(var i=0;i<pieces.length;i++)
								if(pieces[i].m)
									minorPiecesMoved+=s;
					}
				if(minorPiecesMoved!=0) {
					evalValues['minorPiecesMoved']=minorPiecesMoved;
				}
			},
			
		};
	}
	
})();
//# sourceMappingURL=circular-chess-model.js.map
